// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, beforeEach, afterEach, assert, L, turf, HTMLAnchorElement, DEDALO_CORE_URL */
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
import { event_manager } from '../../../core/common/js/event_manager.js'
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
	apply_display,
	RESERVED_PROPERTY_KEYS
} from '../../../tools/tool_uca_maps/js/object_console.js'
import { download_map_image } from '../../../tools/tool_uca_maps/js/map_image_download.js'
import { DEFAULT_MAP_IMAGE_NAME } from '../../../tools/tool_uca_maps/js/download_filename.js'
import { collect_objects, set_object_display, center_on_object } from '../../../tools/tool_uca_maps/js/object_viewer.js'
import { create_image_object, corners_from_viewport, image_download_width } from '../../../tools/tool_uca_maps/js/image_upload.js'
import {
	associate_image,
	object_images,
	object_image_url,
	remove_object_image,
	MAX_OBJECT_IMAGES
} from '../../../tools/tool_uca_maps/js/object_image.js'
import { is_onexone_enabled, create_onexone_rectangle } from '../../../tools/tool_uca_maps/js/onexone.js'
import { DEFAULT_BASEMAPS } from '../../../tools/tool_uca_maps/js/xyz_basemaps.js'
import { parse_wms_capabilities_xml } from '../../../tools/tool_uca_maps/js/wms_services.js'
import { populate_wms_search_results } from '../../../tools/tool_uca_maps/js/render_wms_services.js'
import { UPLOAD_MESSAGE_MS, UPLOAD_ERROR_MESSAGE_MS } from '../../../tools/tool_uca_maps/js/render_file_upload.js'
import { is_catastro_enabled, is_spanish_official_lang, check_catastro_at_point } from '../../../tools/tool_uca_maps/js/catastro.js'
import { check_administrative_unit_at_point } from '../../../tools/tool_uca_maps/js/administrative_units.js'
import { focus_place_result, search_places } from '../../../tools/tool_uca_maps/js/place_search.js'
import { create_position_marker, is_geolocate_enabled, toggle_geolocate } from '../../../tools/tool_uca_maps/js/geolocate.js'
import { populate_place_search_results } from '../../../tools/tool_uca_maps/js/render_place_search.js'
import { format_distance, round_distance } from '../../../tools/tool_uca_maps/js/scale_bar.js'
import {
	empty_legend,
	DEFAULT_ELEMENT_ICON,
	ALLOWED_ICON_TYPES,
	MAX_ICON_BYTES
} from '../../../tools/tool_uca_maps/js/legend.js'
import {
	populate_legend_columns,
	show_legend_message
} from '../../../tools/tool_uca_maps/js/render_legend.js'
import { DEFAULT_SYMBOL_COLOUR } from '../../../tools/tool_uca_maps/js/legend_symbol.js'
import { is_toolbar_node, create_toolbar_panel, remove_toolbar_panel } from '../../../tools/tool_uca_maps/js/toolbar.js'
import {
	search_roman,
	add_roman_result,
	create_roman_objects,
	load_roman_capabilities,
	roman_min_query,
	ROMAN_SOURCES
} from '../../../tools/tool_uca_maps/js/roman_empire.js'
import {
	populate_roman_results,
	refresh_roman_sources
} from '../../../tools/tool_uca_maps/js/render_roman_empire.js'



/** The colour a cataloguer picks in the style field. Named once: a colour
* spelled in a shipped file is counted wherever it is spelled
* (colour_literal_ratchet_tripwire), and seven copies of one test value say
* nothing seven times. */
const PICKED_COLOUR = '#ff0000'



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
		assert.equal(instance.wms_control, null, 'expected wms_control null')
		assert.equal(instance.wms_panel, null, 'expected wms_panel null')
		assert.equal(instance.wms_layers, null, 'expected wms_layers null')
		assert.equal(instance._wms_tile_layers, null, 'expected _wms_tile_layers null')
		assert.equal(instance._wms_search_results, null, 'expected _wms_search_results null')
		assert.equal(instance.catastro_control, null, 'expected catastro_control null')
		assert.equal(instance._catastro_tile_layer, null, 'expected _catastro_tile_layer null')
		assert.equal(instance._catastro_click_handler, null, 'expected _catastro_click_handler null')
		assert.equal(instance._catastro_busy, false, 'expected _catastro_busy false')
		assert.equal(instance.ua_control, null, 'expected ua_control null')
		assert.equal(instance.ua_panel, null, 'expected ua_panel null')
		assert.equal(instance._ua_level, null, 'expected _ua_level null')
		assert.equal(instance._ua_tile_layer, null, 'expected _ua_tile_layer null')
		assert.equal(instance._ua_click_handler, null, 'expected _ua_click_handler null')
		assert.equal(instance._ua_busy, false, 'expected _ua_busy false')
		assert.equal(instance.upload_control, null, 'expected upload_control null')
		assert.equal(instance.upload_panel, null, 'expected upload_panel null')
		assert.equal(instance._upload_busy, false, 'expected _upload_busy false')
		assert.equal(instance._image_upload_busy, false, 'expected _image_upload_busy false')
		assert.equal(instance._image_overlays, null, 'expected _image_overlays null')
		assert.equal(instance._image_overlay_token, null, 'expected _image_overlay_token null')
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
		// "WMS" — functionality #6, WMS server layers
		assert.equal(typeof tool_uca_maps.prototype.attach_wms_services, 'function', 'expected attach_wms_services defined')
		assert.equal(typeof tool_uca_maps.prototype.search_wms_layers, 'function', 'expected search_wms_layers defined')
		assert.equal(typeof tool_uca_maps.prototype.clear_wms_search, 'function', 'expected clear_wms_search defined')
		assert.equal(typeof tool_uca_maps.prototype.add_wms_layer, 'function', 'expected add_wms_layer defined')
		assert.equal(typeof tool_uca_maps.prototype.toggle_wms_layer, 'function', 'expected toggle_wms_layer defined')
		assert.equal(typeof tool_uca_maps.prototype.set_wms_layer_opacity, 'function', 'expected set_wms_layer_opacity defined')
		assert.equal(typeof tool_uca_maps.prototype.delete_wms_layer, 'function', 'expected delete_wms_layer defined')
		// "Catastro" (functionality #8) / "UA" (functionality #9)
		assert.equal(typeof tool_uca_maps.prototype.attach_catastro, 'function', 'expected attach_catastro defined')
		assert.equal(typeof tool_uca_maps.prototype.attach_administrative_units, 'function', 'expected attach_administrative_units defined')
		assert.equal(typeof tool_uca_maps.prototype.on_close_actions, 'function', 'expected on_close_actions defined')
		assert.equal(typeof tool_uca_maps.prototype.close_transient_modal, 'function', 'expected close_transient_modal defined')
		assert.equal(typeof tool_uca_maps.prototype.on_geolocation_destroyed, 'function', 'expected on_geolocation_destroyed defined')
		// "Legend" — functionality #12, the manual legend editor
		assert.equal(typeof tool_uca_maps.prototype.attach_legend, 'function', 'expected attach_legend defined')
		assert.equal(typeof tool_uca_maps.prototype.set_legend_title, 'function', 'expected set_legend_title defined')
		assert.equal(typeof tool_uca_maps.prototype.set_legend_visible, 'function', 'expected set_legend_visible defined')
		assert.equal(typeof tool_uca_maps.prototype.add_legend_column, 'function', 'expected add_legend_column defined')
		assert.equal(typeof tool_uca_maps.prototype.delete_legend_column, 'function', 'expected delete_legend_column defined')
		assert.equal(typeof tool_uca_maps.prototype.set_legend_column_name, 'function', 'expected set_legend_column_name defined')
		assert.equal(typeof tool_uca_maps.prototype.add_legend_element, 'function', 'expected add_legend_element defined')
		assert.equal(typeof tool_uca_maps.prototype.delete_legend_element, 'function', 'expected delete_legend_element defined')
		assert.equal(typeof tool_uca_maps.prototype.set_legend_element_name, 'function', 'expected set_legend_element_name defined')
		assert.equal(typeof tool_uca_maps.prototype.set_legend_element_icon, 'function', 'expected set_legend_element_icon defined')
		assert.equal(typeof tool_uca_maps.prototype.set_legend_element_symbol, 'function', 'expected set_legend_element_symbol defined')
		assert.equal(typeof tool_uca_maps.prototype.move_legend_column, 'function', 'expected move_legend_column defined')
		assert.equal(typeof tool_uca_maps.prototype.move_legend_element, 'function', 'expected move_legend_element defined')
		// "Imperio Romano" — functionality #14, the three gazetteers
		assert.equal(typeof tool_uca_maps.prototype.attach_roman_empire, 'function', 'expected attach_roman_empire defined')
		assert.equal(typeof tool_uca_maps.prototype.search_roman, 'function', 'expected search_roman defined')
		assert.equal(typeof tool_uca_maps.prototype.add_roman_result, 'function', 'expected add_roman_result defined')
		assert.equal(typeof tool_uca_maps.prototype.clear_roman_search, 'function', 'expected clear_roman_search defined')
	})

	// "Legend" (functionality #12, js/legend.js) — PURE, no live map needed.
	// The seed shape is a CONTRACT, not decoration: it is the exact object v6
	// writes into its per-section_tipo JSON the first time
	// (`class.tool_leaflet_special_tools.php` legends()), so the day the foro
	// question #7 closes, persisting is writing this object verbatim.
	it('empty_legend seeds v6\'s own stored shape, and the default icon is self-contained', function() {

		assert.deepEqual(empty_legend(), {legend: '', enable: true, columns: []})

		// no asset URL to resolve: `img-src` admits `data:` (APP_CSP), a tool
		// asset path would have to be built and served
		assert.isTrue(
			DEFAULT_ELEMENT_ICON.startsWith('data:image/svg+xml;base64,'),
			'expected the default pin embedded as a data URL'
		)
		assert.deepEqual(
			ALLOWED_ICON_TYPES,
			['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
			'expected v6\'s own accepted icon types'
		)
		assert.equal(MAX_ICON_BYTES, 2000000, 'expected v6\'s own 2 MB ceiling')
	})

	// "WMS" (functionality #6, js/wms_services.js) — PURE, no network/live map:
	// a hand-written GetCapabilities fixture proves the parsing rule (v6
	// parity: any `queryable` attribute at all, even "0", counts — a plain
	// `getAttribute()!==null` check — and an unnamed layer is a non-leaf
	// grouping node, skipped).
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
					</Layer>
				</Capability>
			</WMS_Capabilities>`

		const result = parse_wms_capabilities_xml(xml)

		assert.equal(result.ok, true)
		assert.deepEqual(result.layers, [
			{name: 'topo:layer2', title: 'Layer Two'},
			{name: 'topo:layer3', title: 'topo:layer3'}
		])
	})

	it('parse_wms_capabilities_xml reports a parse failure on malformed XML', function() {
		const result = parse_wms_capabilities_xml('<not-xml<<<')
		assert.equal(result.ok, false)
		assert.isOk(result.error)
	})

	// review-diff correctness finding: a queryable GROUP layer with no OWN
	// <Name> must never inherit a nested child's <Name>/<Title> — Name/Title
	// lookup has to stop at DIRECT children, not search the whole subtree
	// (Element.getElementsByTagName would otherwise reach into child2 below).
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


	/**
	* ELEVATION (fila #3, hueco portado) — `layer_center` picks the point the
	* server is asked about, `fetch_elevation` asks it, and NEITHER writes
	* anything into the feature: v6 saves `center_elevation` on every click,
	* which would dirty the record just for selecting an object. That
	* not-saving is the thing worth pinning — a regression there is invisible
	* until a user is asked to save a record they only looked at.
	*/
	it('layer_center is a marker\'s own position and any other geometry\'s bounds centre', function() {

		const marker	= geolocation.FeatureGroup[3].getLayers()[0]
		const polygon	= geolocation.FeatureGroup[1].getLayers()[0]

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

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		let asked = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			asked = options
			return { ok:true, data:{ elevation: 412, unavailable:false } }
		}

		const result = await fetch_elevation(tool, layer)

		assert.equal(asked.action, 'get_elevation', 'expected the get_elevation action')
		assert.closeTo(asked.options.lat, 40.45, 0.0001, 'expected the bounds centre latitude')
		assert.closeTo(asked.options.lng ?? asked.options.lon, -3.655, 0.0001, 'expected the bounds centre longitude')
		assert.equal(result.elevation, 412, 'expected the reported elevation')
		assert.equal(result.unavailable, false, 'expected an available verdict')

		// v6 does `layer.feature.properties.center_elevation = ...; save_object()`
		const properties = (layer.feature && layer.feature.properties) || {}
		assert.isUndefined(properties.center_elevation, 'expected NOTHING written into the feature')

		tool.tool_request = original_tool_request
	})

	it('fetch_elevation degrades to unavailable instead of throwing when the service fails', async function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		const original_tool_request = tool.tool_request
		tool.tool_request = async function() {
			return { ok:true, data:{ elevation: null, unavailable:true } }
		}

		const degraded = await fetch_elevation(tool, layer)
		assert.equal(degraded.elevation, null, 'expected no elevation')
		assert.equal(degraded.unavailable, true, 'expected the degraded verdict')

		tool.tool_request = async function() { throw new Error('network down') }
		const thrown = await fetch_elevation(tool, layer)
		assert.equal(thrown.unavailable, true, 'expected an unexpected throw to degrade, not to propagate')

		tool.tool_request = original_tool_request
	})


	/**
	* ASSOCIATED IMAGES + GALLERY (fila #3, hito 16). The upload pipeline
	* itself is the one hito 13 already covers; what is pinned here is what
	* this feature adds on top of it — WHERE the association is stored, that a
	* RELATIVE path is stored rather than v6's absolute URL, that removing an
	* association does not touch the media, and that the PDF export sends
	* record identities and never a file path.
	*/
	it('associate_image refuses with no file and never reaches the server', async function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		tool.active_console_layer = layer

		let asked = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { asked = true; return {} }

		const result = await associate_image(tool, layer, null)

		assert.equal(result.ok, false, 'expected a caller-fault verdict')
		assert.isOk(result.error, 'expected a message to show in the panel')
		assert.equal(asked, false, 'expected NO request without a file')
		assert.deepEqual(object_images(layer), [], 'expected nothing stored')

		tool.tool_request = original_tool_request
	})

	it('associate_image refuses once the object already holds the maximum', async function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		tool.active_console_layer = layer
		layer.feature.properties.uca_maps = { images: Array.from(
			{length: MAX_OBJECT_IMAGES},
			(value, index) => ({file_path: '/' + index + '.jpg', section_tipo:'rsc170', section_id:index, tipo:'rsc29', name:null})
		) }

		let asked = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { asked = true; return {} }

		const result = await associate_image(tool, layer, new File(['x'], 'x.jpg', {type:'image/jpeg'}))

		assert.equal(result.ok, false, 'expected a refusal at the cap')
		assert.isOk(result.error, 'expected a message to show')
		assert.equal(asked, false, 'expected the cap checked BEFORE any upload')
		assert.equal(object_images(layer).length, MAX_OBJECT_IMAGES, 'expected nothing added')

		tool.tool_request = original_tool_request
	})

	it('object_images / object_image_url read the stored descriptors', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		assert.deepEqual(object_images(layer), [], 'expected no images on a fresh object')
		assert.deepEqual(object_images(null), [], 'expected an array, never null')

		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/rsc29/1.5MB/a.jpg', section_tipo:'rsc170', section_id:88, tipo:'rsc29', name:'a.jpg' }
		] }

		assert.equal(object_images(layer).length, 1, 'expected the stored image')

		const url = object_image_url(object_images(layer)[0])
		assert.isOk(url, 'expected a resolvable url')
		assert.isTrue(url.endsWith('/rsc29/1.5MB/a.jpg'), 'expected the stored RELATIVE path resolved against the media url')
		assert.equal(object_image_url({}), null, 'expected null for a descriptor with no path')
	})

	it('a stored descriptor holds NO absolute url — v6 stores one and it breaks on a host change', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/rsc29/1.5MB/a.jpg', section_tipo:'rsc170', section_id:88, tipo:'rsc29', name:'a.jpg' }
		] }

		const stored = object_images(layer)[0]
		assert.isUndefined(stored.url, 'expected NO absolute url stored')
		assert.isTrue(stored.file_path.startsWith('/'), 'expected a media-root-relative path')
		assert.isFalse(/^https?:/.test(stored.file_path), 'expected no scheme in the stored path')
	})

	it('remove_object_image drops the association and refuses an out-of-range index', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/a.jpg', section_tipo:'rsc170', section_id:1, tipo:'rsc29', name:'a' },
			{ file_path:'/b.jpg', section_tipo:'rsc170', section_id:2, tipo:'rsc29', name:'b' }
		] }

		assert.equal(remove_object_image(tool, layer, 5), false, 'expected a refusal past the end')
		assert.equal(remove_object_image(tool, layer, -1), false, 'expected a refusal below zero')
		assert.equal(object_images(layer).length, 2, 'expected nothing removed by a bad index')

		assert.equal(remove_object_image(tool, layer, 0), true, 'expected the first image removed')
		assert.equal(object_images(layer).length, 1, 'expected one left')
		assert.equal(object_images(layer)[0].name, 'b', 'expected the RIGHT one left')
	})

	it('the gallery cap is v6\'s own 30', function() {
		assert.equal(MAX_OBJECT_IMAGES, 30, 'expected v6\'s documented maximum')
	})

	it('download_object_pdf sends record identities and NEVER a file path', async function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/rsc29/1.5MB/a.jpg', section_tipo:'rsc170', section_id:88, tipo:'rsc29', name:'a.jpg' }
		] }

		let asked = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			asked = options
			// a real, minimal PDF so the blob path runs for real
			return { ok:true, data:{
				content_base64	: btoa('%PDF-1.4\n%%EOF\n'),
				filename		: 'uca_maps_object.pdf',
				mime			: 'application/pdf'
			} }
		}

		await download_object_pdf(tool, layer)

		assert.equal(asked.action, 'object_pdf_report', 'expected the pdf action')
		assert.isOk(asked.options.geojson, 'expected the object as geojson')
		assert.equal(asked.options.images.length, 1, 'expected the associated image listed')

		const sent = asked.options.images[0]
		assert.equal(sent.section_tipo, 'rsc170', 'expected the record section')
		assert.equal(sent.section_id, 88, 'expected the record id')
		assert.isUndefined(sent.file_path, 'expected NO file path sent — the server re-resolves it under its own gate')
		assert.isUndefined(sent.url, 'expected no url sent either')

		tool.tool_request = original_tool_request
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

	/**
	* Selecting is not opening (Sergio, 2026-09-21, functional audit). The
	* panel used to fly open on any click on any geometry — and, through
	* toolbar.js's one-panel-at-a-time rule, shut whatever the user had open.
	* v6 does not do that either: a click only replaces the console's
	* content. Pinned in both directions, because the regression is invisible
	* to a test that only checks the content changed.
	*/
	it('opening a drawn layer\'s popup selects it in the console WITHOUT opening the panel', function() {

		tool.attach_console()

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

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
		geolocation.FeatureGroup[3].getLayers()[0].openPopup()
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



	// checkpoint 2b — object functions over the same selection plumbing 2a
	// proved (style/properties/download/centroid/uncertainty/hierarchy).
	// Exercises object_console.js's exported mutation functions directly
	// (same rationale as the rest of this describe block: no get_instance/
	// tool_common ceremony needed) against the seeded polygon layer.

	it('set_style_field writes properties.uca_maps.style and applies it live', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		set_style_field(tool, layer, 'fillColor', PICKED_COLOUR)

		assert.equal(layer.feature.properties.uca_maps.style.fillColor, PICKED_COLOUR, 'expected style written to properties.uca_maps')
		assert.equal(layer.options.fillColor, PICKED_COLOUR, 'expected setStyle applied live')
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
	/**
	* Like `capture_download_blob`, but also reads the name
	* `trigger_blob_download` put on the anchor — the only place the user's
	* typed name is observable on the client-only PNG branch. Stubbing
	* `click` also keeps the headless browser from actually downloading.
	*/
	const capture_download = async function(fn) {
		const original_create_object_url	= URL.createObjectURL
		const original_click				= HTMLAnchorElement.prototype.click
		let captured = {blob: null, name: null}
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


	/**
	* FUNCTIONAL AUDIT, 2026-09-21 — the console's SHAPE, not its plumbing.
	* Each of these pins one thing Sergio found by walking row #3 against v6
	* in the browser; every one of them was green before, because no gate
	* looked at the order of the sections, the heading of one, or the kind of
	* widget a field uses.
	*/
	it('the object section follows v6\'s order: the checkboxes hang from the elevation heading, properties LAST', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

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
		// not a line above them (2026-09-22)
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
	})

	it('style offers v6\'s fields, with v6\'s own ranges, and paints border and body with ONE colour', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

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

		// ONE colour for border and body (v6's own model, 2026-09-22), and the
		// only style value with a split home: the stroke half is the core's
		// `properties.color`, the fill half nobody restores but this tool
		const color = tool.panel_node.querySelector('.uca-maps-style-color')
		assert.isOk(color, 'expected a single colour field (v6 polygon_circle_style)')
		assert.equal(color.type, 'color')
		assert.isNotOk(
			tool.panel_node.querySelector('.uca-maps-style-stroke-color'),
			'expected NO separate stroke-colour field'
		)

		color.value = PICKED_COLOUR
		color.dispatchEvent(new Event('change'))
		assert.equal(layer.options.color, PICKED_COLOUR, 'expected the border painted live')
		assert.equal(layer.options.fillColor, PICKED_COLOUR, 'expected the body painted live, with the same colour')
		assert.equal(
			layer.feature.properties.uca_maps.style.fillColor, PICKED_COLOUR,
			'expected the fill half stored in this tool\'s namespace, which is the only thing that restores it'
		)
		assert.isUndefined(
			layer.feature.properties.uca_maps.style.color,
			'expected the stroke half NOT duplicated here: the core owns properties.color'
		)
	})

	it('the measurement is an ordinary property: listed, editable, deletable', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[2].getLayers()[0] // circle: shape + radius come from the core
		layer.openPopup()

		assert.isOk(layer.feature.properties.area, 'expected the area written into the feature, as v6 does')

		const listed = Array.from(
			tool.panel_node.querySelectorAll('.uca-maps-properties-list .uca-maps-property-key')
		).map(node => node.textContent.replace(':', ''))

		for (const key of ['shape', 'radius', 'area']) {
			assert.include(listed, key, 'expected "' + key + '" offered in the properties list (v6 modal_properties)')
		}

		// idempotent: a second pass must not rewrite and re-dirty the record
		const before = layer.feature.properties.area
		assert.equal(tool.sync_measurements(layer), false, 'expected no write when the measurement has not changed')
		assert.equal(layer.feature.properties.area, before, 'expected the same value')
	})

	it('the associate-image picker stays above the gallery it fills, and is the ONLY step', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

		const images = tool.panel_node.querySelector('.uca-maps-object-images')
		const nodes = Array.from(images.children)
		const index = selector => nodes.findIndex(node => node.matches(selector))

		assert.isBelow(
			index('.uca-maps-object-image-file'), index('.uca-maps-object-gallery'),
			'expected the picker above the gallery: a growing gallery must not push the control down the panel'
		)
		assert.isNotOk(
			images.querySelector('.uca-maps-object-image-associate'),
			'expected NO confirm button: choosing the file associates it (2026-09-22)'
		)
		assert.isOk(images.querySelector('.uca-maps-object-gallery-title'), 'expected the gallery subtitle (v6 "Galería")')
	})

	it('choosing a file is what associates it: the picker\'s own change event runs the upload', async function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

		const picker = tool.panel_node.querySelector('.uca-maps-object-image-file')

		let asked_for	= undefined
		let disabled_during = null
		tool.associate_image = async function(asked_layer, file) {
			asked_for			= asked_layer
			disabled_during	= picker.disabled
			return {ok: true, still_shown: true}
		}

		try {
			picker.dispatchEvent(new Event('change'))
			await new Promise(resolve => setTimeout(resolve, 0))

			assert.equal(asked_for, layer, 'expected the association fired for the selected object, with no second click')
			assert.equal(disabled_during, true, 'expected the picker disabled for the round trip')
		} finally {
			delete tool.associate_image
		}
	})

	it('the Geoman checkbox is per object and only overrides an explicit state', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

		assert.equal(tool.has_geoman_edition(layer), false, 'expected no stored state before anyone ticks it')

		const box = tool.panel_node.querySelector('.uca-maps-geoman input')
		assert.isOk(box, 'expected the "Geoman editing active" checkbox (v6 create_div_geoman_edition_mode)')

		tool.set_geoman_edition(layer, false)
		assert.equal(tool.has_geoman_edition(layer), true, 'expected the state stored once ticked')
		assert.equal(tool.is_geoman_edition(layer), false, 'expected editing off for THIS object')
		assert.equal(layer.pm.enabled(), false, 'expected geoman actually disabled on the layer')

		tool.set_geoman_edition(layer, true)
		assert.equal(tool.is_geoman_edition(layer), true, 'expected editing on for THIS object')
		assert.equal(layer.pm.enabled(), true, 'expected geoman actually enabled on the layer')

		// a sibling in another FeatureGroup is untouched: no stored state, no override
		const other = geolocation.FeatureGroup[2].getLayers()[0]
		assert.equal(tool.has_geoman_edition(other), false, 'expected the state to be per object, not per map')
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

		// audit row #10, H-04 (2026-09-22): v6's own name field, restored.
		const name_input = tool.map_image_panel.querySelector('.uca-maps-map-image-name')
		assert.isOk(name_input, 'expected the file-name field')
		assert.equal(name_input.value, 'map', 'expected it pre-filled with "map", the initial value chosen for this field (v6 opens with "archivo")')
		assert.isOk(tool.map_image_panel.querySelector('.uca-maps-map-image-name-label'), 'expected the field labelled')

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

	it('download_map_image names the PNG with what the user typed, sanitized', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		const captured = await capture_download(() => download_map_image(tool, 'png', '../Necrópolis de Cádiz'))

		assert.isOk(captured.blob, 'expected a Blob')
		assert.equal(captured.name, 'Necrópolis de Cádiz.png', 'expected the typed name, separators stripped and the extension appended once')
	})

	it('download_map_image refuses an EMPTY name (v6 parity) without capturing or calling the server', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let tool_request_called = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			tool_request_called = true
			return original_tool_request.call(tool, options)
		}

		// The refusal has to be VISIBLE, not just "nothing happened": the toast
		// is the whole difference between refusing and failing silently
		// (review-diff, 2026-09-22).
		const errors = []
		const token = event_manager.subscribe('api_error', (error) => errors.push(error))

		// A name that sanitizes to nothing is a refusal, never a silent
		// fallback to the default (download_filename.js).
		const captured = await capture_download(() => download_map_image(tool, 'png', '   '))

		event_manager.unsubscribe(token)

		assert.isNotOk(captured.blob, 'expected no capture at all')
		assert.isNotOk(captured.name, 'expected no download triggered')
		assert.equal(tool_request_called, false, 'expected no server round-trip either')
		assert.equal(errors.length, 1, 'expected exactly one api_error toast telling the user why')
		assert.equal(errors[0].code, 'client.tool_uca_maps_failed', 'expected the tool\'s own client-origin error code')

		tool.tool_request = original_tool_request
	})

	it('download_map_image with NO name argument keeps the default — omitted and empty are different', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		const captured = await capture_download(() => download_map_image(tool, 'png'))

		assert.equal(captured.name, `${DEFAULT_MAP_IMAGE_NAME}.png`, 'expected the default base name when the caller passes nothing')
	})

	it('the panel\'s Download button passes its own field to download_map_image', async function() {

		tool.attach_map_image_download_control()

		const calls = []
		const original = tool.download_map_image
		tool.download_map_image = function(format, file_name) {
			calls.push([format, file_name])
		}

		tool.map_image_panel.querySelector('.uca-maps-map-image-name').value = 'plano general'
		tool.map_image_panel.querySelector('.uca-maps-map-image-format').value = 'jpg'
		tool.map_image_panel.querySelector('.uca-maps-map-image-button').click()

		assert.deepEqual(calls, [['jpg', 'plano general']], 'expected the click to carry BOTH the format and the field\'s current value')

		tool.download_map_image = original
	})

	/**
	* download_map_image('jpg'/'geotiff') round-trips through the REAL server
	* action (`raster_download.ts`, hito 3b) — same tolerant-of-a-missing-
	* binary discipline as 3a's SHP/KML tests (this suite's own ephemeral
	* server runs in the same container that now has both GDAL and
	* ImageMagick).
	*/
	it('download_map_image SENDS the typed name to the server for a server-side format', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		// The only path the name takes to the server is `options.file_name`;
		// nothing gated that it travels at all (review-diff, 2026-09-22). The
		// REAL request still runs — same tolerant shape as the two tests below,
		// so a container without ImageMagick fails the conversion, not this.
		let sent = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			sent = options
			return original_tool_request.call(tool, options)
		}

		await capture_download(() => download_map_image(tool, 'jpg', '../Necrópolis de Cádiz'))

		assert.isOk(sent, 'expected a server round-trip for a non-PNG format')
		assert.equal(sent.action, 'raster_download', 'expected the raster_download action')
		assert.equal(sent.options.file_name, 'Necrópolis de Cádiz', 'expected the SANITIZED name to travel in options.file_name')

		tool.tool_request = original_tool_request
	})

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

	/**
	* FUNCTIONAL AUDIT, 2026-09-22 — row #7 walked against v6. All of it was
	* green before: no gate looked at what the console says about a 1x1, nor
	* at the handles a geometry is born with.
	*/

	it('a geometry created on the map is born with the Geoman handles off and says so; a marker and an image carrier are left alone', async function() {

		tool.attach_console()
		geolocation.active_layer_id = 1

		const polygon = L.polygon([[40.40, -3.71], [40.40, -3.60], [40.50, -3.60]])
		geolocation.map.fire('pm:create', {layer: polygon})
		assert.equal(
			polygon.feature.properties.uca_maps.geoman_edition, false,
			'expected the explicit stored false v6 writes on creation (special_tools_onexone.js)'
		)
		// the stored flag alone would pass on a layer Geoman never touched:
		// reproduce the core's own click sweep (`component_geolocation.js`
		// init_feature runs pm.enable() over every layer of the group) and
		// check the deferred re-assert takes the handles off again — with
		// either half of the fix removed, this goes red
		assert.equal(polygon.pm.enabled(), false, 'expected no vertex handles on a shape nobody asked to edit')
		polygon.pm.enable()
		assert.equal(polygon.pm.enabled(), true, 'expected the simulated core sweep to paint the handles')
		polygon.openPopup()
		await new Promise((resolve) => setTimeout(resolve, 0))
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
			'expected an image carrier left to image_edit.js own seal (hito 14): a new image arrives editable'
		)
	})

	it('re-asserting a stored geoman state that already holds touches nothing — the loop guard', function() {

		tool.attach_console()
		const polygon = geolocation.FeatureGroup[1].getLayers()[0]

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

		assert.equal(
			disables, 0,
			'expected NO pm.disable() on a layer already disabled: Geoman answers it with pm:edit, '
			+ 'the core answers pm:edit with another update_draw_data, and the publish comes straight back here'
		)
		assert.equal(enables, 0, 'expected no pm.enable() either — the stored state is off')

		// and the counters are not silent because the re-assert never got
		// here: put the layer INTO edit mode behind the stored state's back —
		// which is exactly what the core's click sweep does — and the same
		// publish must now disable it, once
		real_enable()
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})
		assert.equal(disables, 1, 'expected the re-assert to reach this layer and clear a state that disagrees')

		polygon.pm.disable	= real_disable
		polygon.pm.enable	= real_enable
	})

	it('the 1x1 marker console carries v6\'s reference-point line and the uncertainty scale', function() {

		tool.attach_console()
		const marker = geolocation.FeatureGroup[3].getLayers()[0]
		create_onexone_rectangle(tool, marker)

		marker.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')

		assert.isOk(
			section.querySelector('.uca-maps-onexone-reference'),
			'expected v6 create_div_oneXone\'s own line: the marker says what it now is'
		)
		const svg = section.querySelector('.uca-maps-uncertainty-scale svg')
		assert.isOk(svg, 'expected the scale bar v6 draws as img/escala-1.png')
		assert.equal(svg.querySelectorAll('rect').length, 6, 'expected v6\'s six bands')
	})

	it('the 1x1 rectangle console prints the nominal area, stores none, and hides the centroid box', function() {

		tool.attach_console()
		const marker = geolocation.FeatureGroup[3].getLayers()[0]
		create_onexone_rectangle(tool, marker)

		const onexone_uid	= marker.feature.properties.uca_maps.onexone_uid
		const rectangle		= geolocation.FeatureGroup[3].getLayers().find((candidate) =>
			candidate.feature
			&& candidate.feature.properties.uca_maps
			&& candidate.feature.properties.uca_maps.uid===onexone_uid
		)

		assert.equal(
			tool.compute_info(rectangle).value, '1 m²',
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

		const plain_polygon = geolocation.FeatureGroup[1].getLayers()[0]
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

	it('the uncertainty scale rings the STORED tier, on any polygon, not only on a 1x1', function() {

		tool.attach_console()
		const polygon = geolocation.FeatureGroup[1].getLayers()[0]
		toggle_uncertainty(tool, polygon)

		polygon.openPopup()
		const section	= tool.panel_node.querySelector('.uca-maps-object-section')
		const svg		= section.querySelector('.uca-maps-uncertainty-scale svg')
		assert.isOk(svg, 'expected the scale bar on a plain polygon too (v6 create_div_incertidumbre)')

		const tier = polygon.feature.properties.uca_maps.uncertainty.scale_tier
		assert.equal(
			svg.querySelectorAll('circle')[0].getAttribute('cx'),
			String(((tier - 1) * 40) + 20),
			'expected the ring on the band of the stored tier, as v6 picks escala-<tier>.png'
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

	it('edit() stacks the dev-only "DEV" button above "UCA"/"IMG"/"OBJ"/"1x1"/"XYZ"/"WMS"/"UP"/"Search"/"GPS"/"Legend"/"Roma" (attach order = corner order)', async function() {

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
			if (button.classList.contains('uca-maps-wms-control'))			return 'WMS'
			if (button.classList.contains('uca-maps-upload-control'))			return 'UP'
			if (button.classList.contains('uca-maps-place-search-control'))	return 'Search'
			if (button.classList.contains('uca-maps-geolocate-control'))		return 'GPS'
			if (button.classList.contains('uca-maps-legend-control'))			return 'Legend'
			if (button.classList.contains('uca-maps-roman-control'))			return 'Roma'
			return 'unknown'
		})
		assert.deepEqual(
			classes,
			['DEV', 'UCA', 'IMG', 'OBJ', '1x1', 'XYZ', 'WMS', 'UP', 'Search', 'GPS', 'Legend', 'Roma'],
			'expected DEV first (topmost), then UCA, IMG, OBJ, 1x1, XYZ, WMS, UP, Search, GPS, Legend, Roma'
		)
	})

	it('edit() also stacks "Catastro"/"UA" last when section_lang gates them in', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.type		= 'tool'
		tool.mode		= 'edit'
		tool.context	= { label: 'Mapas UCA' }

		await tool.edit({})

		const corner = tool.map_control.getContainer().closest('.leaflet-top.leaflet-left')
		const buttons = Array.from(corner.querySelectorAll('.uca-maps-toolbar-button'))
		const classes = buttons.map((button) => {
			if (button.classList.contains('uca-maps-catastro-control'))	return 'Catastro'
			if (button.classList.contains('uca-maps-ua-control'))			return 'UA'
			return 'other'
		}).filter((name) => name!=='other')

		assert.deepEqual(classes, ['Catastro', 'UA'], 'expected Catastro then UA, last in the corner')
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



	// "WMS" (functionality #6, js/wms_services.js). Unlike XYZ, this
	// functionality never touches geolocation.layer_control (v6's own
	// equivalent doesn't either — plain L.TileLayer.WMS instances added/
	// removed straight from the map), so there is no layer_control-takeover
	// scenario to cover here. The GetCapabilities network call is always
	// MOCKED (tool.tool_request stubbed) — the real SSRF-guarded proxy +
	// XML fetch is covered server-side, hermetically, in
	// test/unit/tool_uca_maps_get_wms_layers.test.ts; a client suite must
	// never depend on a live third-party WMS server being reachable.

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

	it('attach_wms_services seeds an empty session-only layer list and builds the button+panel', function() {

		tool.attach_wms_services()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-wms-control')
		assert.isOk(control, 'expected the "WMS" toggle button')
		assert.isOk(tool.wms_panel, 'expected the wms panel built')
		assert.equal(tool.wms_panel.hidden, true, 'expected the panel hidden by default')
		assert.deepEqual(tool.wms_layers, [], 'expected no layers pre-added, unlike XYZ\'s 3 defaults')
		assert.isOk(geolocation.map.getPane('wms'), 'expected the dedicated "wms" pane created')
	})

	it('search_wms_layers refuses a non-absolute-http(s) URL without touching the server', async function() {

		tool.attach_wms_services()

		let called = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { called = true; return original_tool_request.apply(this, arguments) }

		const result = await tool.search_wms_layers('not-a-url')

		assert.equal(result.ok, false)
		assert.equal(called, false, 'expected the server never contacted for an invalid URL')

		tool.tool_request = original_tool_request
	})

	// review-diff correctness finding: an unexpected throw must resolve to a
	// failure object, never an unhandled rejection that leaves the panel's
	// "Search" button stuck disabled (render_wms_services.js's click handler
	// only re-enables it after the awaited call settles).
	it('search_wms_layers never rejects, even when tool_request throws unexpectedly', async function() {

		tool.attach_wms_services()
		tool.tool_request = async function() { throw new Error('boom') }

		const result = await tool.search_wms_layers('https://example.com/geoserver/wms')

		assert.equal(result.ok, false)
		assert.isOk(result.error)
	})

	// review-diff correctness finding: a response that lands AFTER the tool
	// was torn down (record deleted/navigated away mid-request) must not
	// resurrect state on a dead instance.
	it('search_wms_layers drops a response that arrives after detach_wms_services already ran', async function() {

		tool.attach_wms_services()

		let resolve_tool_request
		tool.tool_request = () => new Promise((resolve) => { resolve_tool_request = resolve })

		const pending = tool.search_wms_layers('https://example.com/geoserver/wms')

		await tool.destroy(false, false, false)
		assert.equal(tool.wms_panel, null, 'expected the panel already torn down')

		resolve_tool_request({ok: true, data: {url: 'https://example.com/geoserver/wms', xml: SAMPLE_CAPABILITIES_XML}})
		const result = await pending

		assert.equal(result.ok, false)
		assert.equal(tool._wms_search_results, null, 'expected the late response NOT to resurrect state on the torn-down instance')
	})

	it('search_wms_layers (mocked server) stores the parsed results; the panel lists them with an "Add" button', async function() {

		// the network half (SSRF-guarded proxy, real GetCapabilities fetch) is
		// covered server-side (file header above) — tool_request is stubbed
		// here so this test stays hermetic and exercises tool_request/
		// search_wms_layers/populate_wms_search_results/add_wms_layer
		// DIRECTLY (awaited calls, not a real DOM click + microtask race)
		tool.attach_wms_services()
		const panel = tool.wms_panel

		let requested_options = null
		tool.tool_request = async function(options) {
			requested_options = options
			return {ok: true, data: {url: 'https://example.com/geoserver/wms', xml: SAMPLE_CAPABILITIES_XML}}
		}

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

	it('delete_wms_layer removes the tile layer from the live map and from the list', function() {

		tool.attach_wms_services()
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One'})
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer2', title: 'Layer Two'})

		const first_tile_layer = tool._wms_tile_layers[0]

		assert.deepEqual(tool.delete_wms_layer(0), {ok: true})
		assert.equal(tool.wms_layers.length, 1)
		assert.equal(tool.wms_layers[0].name, 'topo:layer2', 'expected the survivor to be the second-added layer')
		assert.equal(geolocation.map.hasLayer(first_tile_layer), false, 'expected the deleted layer off the map')
	})

	// Row #6 audit (2026-09-23): the panel opens centred with a ×, and
	// show/hide is v6's eye drawing the STATE. The suite loads no tool CSS, so
	// "centered" is asserted as what toolbar.js does (class, never anchored),
	// not as measured geometry.
	it('the WMS panel opens centered — never anchored to its button — and its × closes it', function() {

		tool.attach_wms_services()
		const panel		= tool.wms_panel
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-wms-control')

		assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), 'expected the centered variant')
		const title = panel.querySelector(':scope > .uca-maps-panel-header > .uca-maps-panel-title')
		assert.equal(title.textContent, 'WMS services', 'expected toolbar.js to build the header title')
		assert.equal(panel.querySelectorAll('.uca-maps-panel-header').length, 1, 'expected ONE header — render_wms_services no longer builds its own')

		control.click()
		assert.equal(panel.hidden, false, 'expected the panel open after its own click')
		assert.equal(panel.style.top, '', 'expected no inline top: anchor_panel_to_button must not run')
		assert.equal(panel.style.left, '', 'expected no inline left: anchor_panel_to_button must not run')

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

	// H-11: the value was set before type='range', so the range sanitized it
	// against its default 0..100 step 1 and a 0.7 layer showed its slider at 1
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

	// The fix Sergio asked for is layout, so this one loads the tool's own
	// stylesheet (the suite otherwise has none) and measures it: with several
	// long names added, each name keeps most of its row, and the panel sits
	// centred across the map, 5rem below its top (v6's modal box), rather
	// than at the 18rem anchored default.
	it('with the tool CSS, a WMS layer name keeps its width and the panel sits centred near the map top', async function() {

		const link = document.createElement('link')
		link.rel	= 'stylesheet'
		link.href	= new URL('../../../tools/tool_uca_maps/css/tool_uca_maps.css', import.meta.url).href
		await new Promise((resolve, reject) => {
			link.addEventListener('load', resolve)
			link.addEventListener('error', reject)
			document.head.appendChild(link)
		})

		try {
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
		} finally {
			link.remove()
		}
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

	// "Catastro" (functionality #8, js/catastro.js) / "UA" (functionality #9,
	// js/administrative_units.js). Both gated on section_lang (v6 parity —
	// es/cat/eus); the shared fixture (elements.js) sets no section_lang, so
	// it defaults to the "not gated in" case unless a test opts in. Every
	// outbound call is MOCKED (tool.tool_request stubbed) — the real proxies
	// are covered hermetically server-side (test/unit/tool_uca_maps_get_
	// catastro_parcel.test.ts / …get_administrative_unit.test.ts); a client
	// suite must never depend on a live third-party server being reachable.
	// Both SWAP the active basemap (v6 parity, confirmed live by Sergio,
	// 2026-09-08 validation) — this helper reads it straight off the map,
	// same "DOM/map is truth" law as everything else in this suite.
	const find_active_tile_layer = function(map) {
		let found = null
		map.eachLayer((layer) => { if (layer instanceof L.TileLayer) found = layer })
		return found
	}

	it('attach_catastro/attach_administrative_units are a no-op unless section_lang is es/cat/eus (v6 parity)', function() {

		assert.equal(geolocation.section_lang, undefined, 'expected the shared fixture to set no section_lang')
		assert.equal(is_spanish_official_lang(tool), false)

		tool.attach_catastro()
		tool.attach_administrative_units()

		assert.equal(tool.catastro_control, null, 'expected no "Catastro" button gated out')
		assert.equal(tool.ua_control, null, 'expected no "UA" button gated out')
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

	// v6 parity, confirmed live by Sergio (2026-09-08 validation): Catastro
	// SWAPS the active basemap (marked in the map's own layer-control) rather
	// than adding a translucent overlay on top of it.
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

	it('check_catastro_at_point (found) creates a polygon with a visible "url" property, not hidden uca_maps bookkeeping', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		tool.catastro_control.getContainer().click() // arm

		let requested_options = null
		tool.tool_request = async function(options) {
			requested_options = options
			return {ok: true, data: {found: true, refcat: '1234567AB1234C', url: 'https://example.com/parcel', points: [[40.1, -3.7], [40.2, -3.7], [40.2, -3.6], [40.1, -3.6]]}}
		}

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		assert.equal(requested_options.action, 'get_catastro_parcel')
		assert.isOk(Array.isArray(requested_options.options.bbox) && requested_options.options.bbox.length===4, 'expected a 4-number bbox')

		const layers = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers()
		assert.equal(layers.length, before_layer_count + 1, 'expected one new polygon added to the active FeatureGroup')
		const created = layers[layers.length - 1]
		assert.equal(created.feature.properties.url, 'https://example.com/parcel', 'expected a REGULAR, visible "url" property (v6 parity)')
		assert.equal(created.feature.properties.uca_maps.catastro, true)
	})

	// v6 prints any URL-valued property as a "Más información" link; here only
	// the parcel's own url, titled "Catastro" (Sergio, 2026-09-24).
	it('the console shows a parcel\'s url as a read-only "Catastro" link; the same key typed by hand stays editable text', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		tool.attach_console()
		tool.catastro_control.getContainer().click() // arm
		tool.tool_request = async function() {
			return {ok: true, data: {found: true, refcat: '1234567AB1234C', url: 'https://example.com/parcel?rc1=1&rc2=2', points: [[40.1, -3.7], [40.2, -3.7], [40.2, -3.6], [40.1, -3.6]]}}
		}
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		const layers	= geolocation.FeatureGroup[geolocation.active_layer_id].getLayers()
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

	it('check_catastro_at_point (not found) shows a message, creates nothing', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		tool.catastro_control.getContainer().click() // arm

		tool.tool_request = async () => ({ok: true, data: {found: false}})

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		assert.equal(
			geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length,
			before_layer_count,
			'expected no polygon created on a "not found" result'
		)
		const banner = geolocation.node.querySelector('.uca-maps-catastro-message')
		assert.isOk(banner, 'expected an in-component message banner')
		assert.match(banner.textContent, /parcel/i)
	})

	it('check_catastro_at_point refuses overlapping lookups (busy guard) — only the first reaches tool_request', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		tool.catastro_control.getContainer().click() // arm

		let call_count = 0
		let resolve_first
		tool.tool_request = () => new Promise((resolve) => {
			call_count++
			resolve_first = () => resolve({ok: true, data: {found: false}})
		})

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

	// review-diff finding, hito 11: a lookup in flight when the user disarms
	// Catastro (second click) must not resurrect a parcel after the fact.
	it('check_catastro_at_point drops a response that arrives after the user disarms Catastro mid-request', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		tool.catastro_control.getContainer().click() // arm

		let resolve_tool_request
		tool.tool_request = () => new Promise((resolve) => { resolve_tool_request = resolve })

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		const pending = check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		tool.catastro_control.getContainer().click() // disarm WHILE the request is in flight
		assert.equal(is_catastro_enabled(tool), false, 'expected Catastro disarmed')

		resolve_tool_request({ok: true, data: {found: true, refcat: '1234567AB1234C', url: 'https://example.com/parcel', points: [[40.1, -3.7], [40.2, -3.7], [40.2, -3.6]]}})
		await pending

		assert.equal(
			geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length,
			before_layer_count,
			'expected the late "found" response NOT to create a parcel after Catastro was disarmed'
		)
	})

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

	// v6 parity, confirmed live by Sergio (2026-09-08 validation): UA SWAPS
	// the active basemap for AU.AdministrativeUnit (same fix as Catastro).
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

	// review-diff finding, hito 11: toolbar.js's own exclusivity (opening ANY
	// sibling panel force-hides an already-open one) used to hide the UA
	// panel WITHOUT disarming it — the overlay tile layer and the map 'click'
	// listener kept running behind a panel that looked closed. Fixed via
	// create_toolbar_panel's `on_hide` hook.
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

	it('check_administrative_unit_at_point (found) builds a layer via L.geoJSON and fires pm:create', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_administrative_units()
		tool.ua_control.getContainer().click() // arm, level defaults to 'Municipio'

		let requested_options = null
		tool.tool_request = async function(options) {
			requested_options = options
			return {ok: true, data: {found: true, feature: {
				type: 'Feature',
				geometry: {type: 'Polygon', coordinates: [[[-3.71,40.40],[-3.60,40.40],[-3.60,40.50],[-3.71,40.50],[-3.71,40.40]]]},
				properties: {nameunit: 'Test municipality'}
			}}}
		}

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

		assert.equal(requested_options.action, 'get_administrative_unit')
		assert.equal(requested_options.options.level, 'Municipio')

		const layers = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers()
		assert.equal(layers.length, before_layer_count + 1, 'expected one new object added to the active FeatureGroup')
		assert.equal(layers[layers.length - 1].feature.properties.nameunit, 'Test municipality', 'expected the raw IGN properties kept, v6 parity')
	})

	it('check_administrative_unit_at_point (not found) shows an in-panel message, creates nothing', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_administrative_units()
		tool.ua_control.getContainer().click() // arm

		tool.tool_request = async () => ({ok: true, data: {found: false}})

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

		assert.equal(
			geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length,
			before_layer_count,
			'expected no object created on a "not found" result'
		)
		const message = tool.ua_panel.querySelector('.uca-maps-ua-message')
		assert.equal(message.hidden, false, 'expected the in-panel message shown')
	})

	// review-diff finding, hito 11: a lookup in flight when the user closes
	// the UA panel (own toggle, here — the sibling-panel path is covered by
	// the toolbar-exclusivity test above) must not resurrect an object.
	it('check_administrative_unit_at_point drops a response that arrives after the UA panel is closed mid-request', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_administrative_units()
		tool.ua_control.getContainer().click() // arm

		let resolve_tool_request
		tool.tool_request = () => new Promise((resolve) => { resolve_tool_request = resolve })

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
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
			geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length,
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



	// hito 12 — functionality #11, "Upload file to map", VECTOR HALF ONLY
	// (js/vector_upload.js). No language/section_tipo gate, unlike Catastro/
	// UA. The real round-trip tests exercise BOTH the engine's own generic
	// service_upload.js transport AND this tool's own upload_vector_layer
	// server action — tolerant of a missing GDAL binary the same way
	// download_vector('shp'/'kml') already are (file header above): the
	// suite's dev container has GDAL (hito 3), so these are exercised for
	// real there, not merely mocked.
	const SAMPLE_UPLOAD_GEOJSON = {
		type		: 'FeatureCollection',
		features	: [{
			type		: 'Feature',
			properties	: {},
			geometry	: { type: 'Point', coordinates: [-3.65, 40.45] }
		}]
	}

	it('attach_file_upload builds its own button+panel', function() {

		tool.attach_file_upload()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-upload-control')
		assert.isOk(control, 'expected the "Upload file to map" toggle button')
		assert.isOk(tool.upload_panel, 'expected the upload panel built')
		assert.equal(tool.upload_panel.hidden, true, 'expected the panel hidden by default')
	})

	it('upload_vector_file refuses without a file, never touching the network', async function() {

		tool.attach_file_upload()

		let called = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { called = true; return original_tool_request.apply(this, arguments) }

		const result = await tool.upload_vector_file(null, {})

		assert.equal(result.ok, false)
		assert.equal(called, false, 'expected the server never contacted with no file selected')

		tool.tool_request = original_tool_request
	})

	it('upload_vector_file (real round trip) uploads a .geojson file and creates a matching object, or reports GDAL unavailable', async function() {

		tool.attach_file_upload()

		const before_layer_count = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		const file = new File([JSON.stringify(SAMPLE_UPLOAD_GEOJSON)], 'test.geojson', {type: 'application/geo+json'})

		const result = await tool.upload_vector_file(file, {})

		if (!result.ok) {
			assert.include(
				result.error || '', 'GDAL',
				'expected the only acceptable failure to mention GDAL — full result: ' + JSON.stringify(result)
			)
			return
		}

		assert.equal(result.feature_count, 1, 'expected exactly the one uploaded feature')
		assert.equal(
			geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length,
			before_layer_count + 1,
			'expected one new object added to the active FeatureGroup via pm:create'
		)
	})

	it('upload_vector_file (real round trip) surfaces a malformed EPSG code as a server-side request.invalid_options error, without needing GDAL', async function() {

		tool.attach_file_upload()

		let response	= null
		let sent		= null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			sent		= options
			response	= await original_tool_request.call(tool, options)
			return response
		}

		const file = new File([JSON.stringify(SAMPLE_UPLOAD_GEOJSON)], 'test.geojson', {type: 'application/geo+json'})

		// the EPSG format check runs BEFORE the ogr2ogr call (vector_upload.ts),
		// so this exercises the real staged-upload + server round trip without
		// depending on GDAL being installed. Asserted on the RAW response's
		// error CODE, never the rendered text: request.invalid_options carries
		// a registered label_key (master.json error_request_invalid_options),
		// and error_text() (render_api_error.js) always prefers that catalog
		// label over whatever specific message/publicMessage the server set —
		// same reason the download_vector('jpg'/'geotiff') tests above assert
		// on response.error.code, never on rendered text.
		const result = await tool.upload_vector_file(file, {epsg: 'not-a-code', zone: '30', band: 'N'})

		assert.equal(result.ok, false)
		assert.isOk(response, 'expected tool_request to have been reached')
		assert.equal(response.error && response.error.code, 'request.invalid_options')
		// all three reach the wire: a dropped zone or band would make the server
		// refuse every UTM projection, and nothing else here would notice
		assert.deepInclude(sent.options, {epsg: 'not-a-code', zone: '30', band: 'N'})
	})

	it('upload_vector_file drops a response that arrives after detach_file_upload already ran', async function() {

		tool.attach_file_upload()

		let resolve_tool_request
		tool.tool_request = () => new Promise((resolve) => { resolve_tool_request = resolve })

		const file = new File([JSON.stringify(SAMPLE_UPLOAD_GEOJSON)], 'test.geojson', {type: 'application/geo+json'})
		const pending = tool.upload_vector_file(file, {})

		// wait for the (real) service_upload transport to finish staging the
		// file and reach the point where it calls tool.tool_request — polling
		// is the only signal available, tool_request itself has no "about to
		// call" hook
		for (let i=0; i<200 && !resolve_tool_request; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.isOk(resolve_tool_request, 'expected tool_request reached within the wait budget')

		await tool.destroy(false, false, false)
		assert.equal(tool.upload_panel, null, 'expected the panel already torn down')

		resolve_tool_request({ok: true, data: {geojson: SAMPLE_UPLOAD_GEOJSON, feature_count: 1}})
		const result = await pending

		assert.equal(result.ok, false)
	})


	// hito 13 — functionality #11, IMAGE HALF (js/image_upload.js), inside the
	// SAME button+panel the vector half builds.
	//
	// NO real end-to-end upload here, deliberately. Doing one would mint an
	// rsc170 record + real media on every run with no id handed back to sweep
	// it, so the suite DB would accumulate orphans run after run — the exact
	// thing "DB writes in tests only on scratch surfaces; clean up after"
	// forbids. The server half is pinned by
	// test/unit/tool_uca_maps_image_overlay.test.ts (real gdalinfo), the
	// staging transport is the same service_upload the vector tests above
	// exercise for real, and the full round trip is a manual-validation step
	// in the hito 13 dossier. What IS covered here is everything that lives
	// only in the browser: the panel, the refusal, and the overlay lifecycle
	// (hydrate / console / teardown) driven off a carrier built by hand — the
	// same shape a saved record hands back on load.
	const IMAGE_DESCRIPTOR = {
		file_path		: '/image/1.5MB/rsc29_rsc170_1.jpg',
		quality			: '1.5MB',
		section_tipo	: 'rsc170',
		section_id		: 1,
		tipo			: 'rsc29',
		corners			: {
			top_left	: [40.46, -3.66],
			top_right	: [40.46, -3.64],
			bottom_left	: [40.44, -3.66]
		},
		opacity			: 1,
		z_index			: 200
	}

	// create_image_object ends in map.fitBounds(), which starts a ZOOM
	// ANIMATION. Ending a test with the frame still queued hands afterEach a
	// map it destroys under a pending _move(), and Leaflet throws inside the
	// NEXT test's beforeEach. Every create_image_object test waits on this.
	function settle_map(map) {
		return new Promise((resolve) => {
			const settled = () => resolve()
			map.once('moveend', settled)
			setTimeout(settled, 1000) // fitBounds on an already-matching view fires nothing
		})
	}

	function add_image_carrier() {
		const carrier = L.rectangle([[40.44, -3.66], [40.46, -3.64]], {opacity: 0, fillOpacity: 0})
		carrier.feature = carrier.toGeoJSON()
		// the same two properties create_image_object writes in production
		carrier.feature.properties.uca_maps = {
			image		: JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR)),
			is_raster	: true
		}
		geolocation.FeatureGroup[geolocation.active_layer_id].addLayer(carrier)
		return carrier
	}

	it('the upload panel carries the image sub-flow as well as the vector one', function() {

		tool.attach_file_upload()

		assert.isOk(
			tool.upload_panel.querySelector('.uca-maps-upload-image-file'),
			'expected the image file input in the same panel'
		)
		assert.isOk(
			tool.upload_panel.querySelector('.uca-maps-upload-file'),
			'expected the vector file input still there — one row, one panel'
		)
		// the vector half uploads from its own button (2026-09-28); the image
		// half still uploads on pick, so it has none
		assert.deepEqual(
			Array.from(tool.upload_panel.querySelectorAll('button')).map(b => b.className),
			['uca-maps-upload-projections-button', 'uca-maps-upload-submit'],
			'expected v6\'s projections toggle and the vector Upload button, nothing in the image half'
		)
	})

	// hand the picker a real FileList, then fire what the browser fires
	function pick_file(input, file) {
		const transfer = new DataTransfer()
		transfer.items.add(file)
		input.files = transfer.files
		input.dispatchEvent(new Event('change'))
	}

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

	it('the vector half is v6\'s modal: title, picker, extensions, projections toggle, explanation, EPSG/zone/band, epsg.io, then Upload', function() {

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
		const file		= new File(['x'], 'plan.png', {type: 'image/png'})

		let asked_for		= null
		let disabled_during	= null
		tool.upload_image_file = async function(given) {
			asked_for		= given
			disabled_during	= picker.disabled
			return {ok: true, georeferenced: true}
		}

		try {
			pick_file(picker, file)
			await new Promise(resolve => setTimeout(resolve, 0))

			assert.equal(asked_for, file, 'expected the upload fired by the pick, with no second click')
			assert.equal(disabled_during, true, 'expected the picker disabled for the round trip')
			assert.equal(picker.disabled, false, 'expected the picker enabled again afterwards')
			assert.equal(picker.value, '', 'expected the picker emptied, so the same file can be picked again')
			assert.equal(messages[0].hidden, true, 'expected the vector half\'s line untouched')
			assert.equal(messages[1].hidden, false, 'expected the result in the image half')
			assert.equal(messages[1].textContent, tool.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.')
		} finally {
			delete tool.upload_image_file
		}
	})

	// load the picker without firing anything: the vector half uploads on click
	function load_file(input, file) {
		const transfer = new DataTransfer()
		transfer.items.add(file)
		input.files = transfer.files
	}

	it('the vector half says how many objects an upload created, or that it read none', async function() {

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-file')
		const submit	= tool.upload_panel.querySelector('.uca-maps-upload-submit')
		const message	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[0]
		const file		= new File(['{}'], 'plan.geojson', {type: 'application/geo+json'})

		let answer = {ok: true, feature_count: 0}
		tool.upload_vector_file = async function() { return answer }

		try {
			load_file(picker, file)
			submit.click()
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(message.textContent, tool.get_tool_label('upload_no_features') || 'No objects could be read from this file.')

			answer = {ok: true, feature_count: 3}
			submit.click()
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(message.textContent, (tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (3)')
			assert.equal(picker.value, '', 'expected the picker emptied after a success')
		} finally {
			delete tool.upload_vector_file
		}
	})

	it('an upload that outlives the panel writes nothing to it', async function() {

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-file')
		const submit	= tool.upload_panel.querySelector('.uca-maps-upload-submit')
		const message	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[0]

		let settle = null
		tool.upload_vector_file = function() {
			return new Promise((resolve) => { settle = resolve })
		}

		try {
			load_file(picker, new File(['{}'], 'plan.geojson', {type: 'application/geo+json'}))
			submit.click()
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.isOk(settle, 'expected the upload in flight')

			await tool.destroy(false, false, false)
			assert.equal(tool.upload_panel, null, 'expected the panel already torn down')
			settle({ok: false, error: 'late answer'})
			await new Promise(resolve => setTimeout(resolve, 0))

			assert.equal(message.isConnected, false, 'expected the panel gone')
			assert.equal(message.hidden, true, 'expected the late answer never written')
			assert.equal(picker.disabled, true, 'expected the detached picker left as it was')
			assert.equal(submit.disabled, true, 'expected the detached button left as it was')
		} finally {
			delete tool.upload_vector_file
		}
	})

	it('an image placement message goes away by itself; an upload error too, later (v6\'s 3.5 s)', async function() {

		this.timeout(UPLOAD_MESSAGE_MS + UPLOAD_ERROR_MESSAGE_MS + 2000)

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-image-file')
		const message	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[1]
		const file		= new File(['x'], 'plan.png', {type: 'image/png'})

		let answer = {ok: true, georeferenced: false}
		tool.upload_image_file = async function() { return answer }

		try {
			pick_file(picker, file)
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(message.hidden, false, 'expected the placement message shown first')
			await new Promise(resolve => setTimeout(resolve, UPLOAD_MESSAGE_MS + 200))
			assert.equal(message.hidden, true, 'expected it gone after a couple of seconds')

			answer = {ok: false, error: 'the ingest refused it'}
			pick_file(picker, file)
			await new Promise(resolve => setTimeout(resolve, UPLOAD_MESSAGE_MS + 200))
			assert.equal(message.hidden, false, 'expected an error still there after the success window')
			assert.equal(message.textContent, 'the ingest refused it')
			await new Promise(resolve => setTimeout(resolve, UPLOAD_ERROR_MESSAGE_MS - UPLOAD_MESSAGE_MS))
			assert.equal(message.hidden, true, 'expected the error gone after UPLOAD_ERROR_MESSAGE_MS')
		} finally {
			delete tool.upload_image_file
		}
	})

	it('a vector success goes away by itself, as the image one does; a vector error too, later', async function() {

		this.timeout(UPLOAD_MESSAGE_MS + UPLOAD_ERROR_MESSAGE_MS + 2000)

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-file')
		const submit	= tool.upload_panel.querySelector('.uca-maps-upload-submit')
		const message	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[0]
		const file		= new File(['{}'], 'plan.geojson', {type: 'application/geo+json'})

		let answer = {ok: true, feature_count: 2}
		tool.upload_vector_file = async function() { return answer }

		try {
			load_file(picker, file)
			submit.click()
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(message.hidden, false, 'expected the success shown first')
			await new Promise(resolve => setTimeout(resolve, UPLOAD_MESSAGE_MS + 200))
			assert.equal(message.hidden, true, 'expected it gone after the image message\'s window')

			answer = {ok: false, error: 'zone and band do not match'}
			load_file(picker, file)
			submit.click()
			await new Promise(resolve => setTimeout(resolve, UPLOAD_MESSAGE_MS + 200))
			assert.equal(message.hidden, false, 'expected an error still there after the success window')
			assert.equal(message.textContent, 'zone and band do not match')
			await new Promise(resolve => setTimeout(resolve, UPLOAD_ERROR_MESSAGE_MS - UPLOAD_MESSAGE_MS))
			assert.equal(message.hidden, true, 'expected the error gone after UPLOAD_ERROR_MESSAGE_MS')
		} finally {
			delete tool.upload_vector_file
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

		try {
			tool.upload_control.getContainer().click()

			load_file(vector_picker, new File(['{}'], 'plan.geojson', {type: 'application/geo+json'}))
			panel.querySelector('.uca-maps-upload-epsg').value = '25830'
			panel.querySelector('.uca-maps-upload-submit').click()
			pick_file(image_picker, new File(['x'], 'plan.png', {type: 'image/png'}))
			await new Promise(resolve => setTimeout(resolve, 0))
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
		} finally {
			delete tool.upload_vector_file
			delete tool.upload_image_file
		}
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

		try {
			toggle()
			pick_file(picker, new File(['x'], 'plan.png', {type: 'image/png'}))
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.isOk(settle, 'expected the upload in flight')
			assert.equal(message.hidden, false, 'expected the working line shown')

			toggle()
			toggle()
			assert.equal(message.hidden, false, 'expected the working line kept while the upload runs')
			assert.equal(picker.disabled, true, 'expected the picker still locked')

			settle({ok: true, georeferenced: true})
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(message.textContent, tool.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.')
			assert.equal(picker.disabled, false)
		} finally {
			delete tool.upload_image_file
		}
	})

	it('reopening UP mid vector upload leaves its file, fields and controls alone', async function() {

		tool.attach_file_upload()

		const panel		= tool.upload_panel
		const toggle	= () => tool.upload_control.getContainer().click()
		const picker	= panel.querySelector('.uca-maps-upload-file')
		const submit	= panel.querySelector('.uca-maps-upload-submit')
		const message	= panel.querySelectorAll('.uca-maps-upload-message')[0]
		const inputs	= Array.from(panel.querySelectorAll('.uca-maps-upload-epsg-row input'))
		const file		= new File(['{}'], 'plan.geojson', {type: 'application/geo+json'})

		let settle = null
		tool.upload_vector_file = function() {
			return new Promise((resolve) => { settle = resolve })
		}

		try {
			toggle()
			load_file(picker, file)
			inputs[0].value = '25830'
			inputs[1].value = '30'
			inputs[2].value = 'N'
			submit.click()
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.isOk(settle, 'expected the upload in flight')

			toggle()
			toggle()
			assert.equal(picker.files[0], file, 'expected the file kept while the upload runs')
			assert.deepEqual(inputs.map(i => i.value), ['25830', '30', 'N'], 'expected the fields kept')
			assert.equal(picker.disabled, true, 'expected the picker still locked')
			assert.equal(submit.disabled, true, 'expected Upload still locked')

			settle({ok: true, feature_count: 1})
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(message.textContent, (tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (1)')
			assert.equal(submit.disabled, false)
		} finally {
			delete tool.upload_vector_file
		}
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

		try {
			toggle()
			assert.equal(panel.hidden, false, 'expected UP open')

			load_file(picker, new File(['{}'], 'plan.geojson', {type: 'application/geo+json'}))
			epsg.value = '25830'
			epsg.dispatchEvent(new Event('input'))
			panel.querySelector('.uca-maps-upload-zone').value = '30'
			panel.querySelector('.uca-maps-upload-band').value = 'N'
			panel.querySelector('.uca-maps-upload-projections-button').click()
			panel.querySelector('.uca-maps-upload-submit').click()
			await new Promise(resolve => setTimeout(resolve, 0))
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
		} finally {
			delete tool.upload_vector_file
		}
	})

	it('the teardown cancels a pending hide timer', async function() {

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-image-file')
		const message	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[1]
		tool.upload_image_file = async function() { return {ok: true, georeferenced: true} }

		try {
			pick_file(picker, new File(['x'], 'plan.png', {type: 'image/png'}))
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.isOk(message._uca_maps_hide_timer, 'expected a hide timer armed')

			await tool.destroy(false, false, false)
			assert.equal(message._uca_maps_hide_timer, null, 'expected the timer cancelled with the panel')
		} finally {
			delete tool.upload_image_file
		}
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

		try {
			const file = new File(['{}'], 'plan.geojson', {type: 'application/geo+json'})
			pick_file(picker, file)
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(asked_for, null, 'expected choosing the file to upload nothing')

			submit.click()
			await new Promise(resolve => setTimeout(resolve, 0))

			assert.deepEqual(
				asked_for, {file, projection: {epsg: '25830', zone: '30', band: 'N'}},
				'expected Upload to send the chosen file with the three fields\' values'
			)
			// the retry is: correct the fields, press Upload again
			assert.equal(picker.files[0], file, 'expected the file kept after a failure')
			assert.equal(submit.disabled, false, 'expected Upload enabled again')
			assert.equal(messages[0].textContent, 'no coordinate system', 'expected the error in the vector half')
			assert.equal(messages[1].hidden, true, 'expected the image half\'s line untouched')
		} finally {
			delete tool.upload_vector_file
		}
	})

	it('upload_image_file refuses without a file, never touching the network', async function() {

		tool.attach_file_upload()

		let called = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { called = true; return original_tool_request.apply(this, arguments) }

		const result = await tool.upload_image_file(null)

		assert.equal(result.ok, false)
		assert.equal(called, false, 'expected the server never contacted with no file selected')

		tool.tool_request = original_tool_request
	})

	it('attach_image_overlays rebuilds a saved overlay from its carrier rectangle', async function() {

		const carrier = add_image_carrier()

		tool.attach_image_overlays()

		// the plugin loads on demand (classic <script>), so the overlay
		// appears asynchronously
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}

		assert.isOk(carrier._uca_maps_overlay, 'expected the overlay rebuilt from properties.uca_maps.image')
		assert.equal(
			geolocation.map.hasLayer(carrier._uca_maps_overlay), true,
			'expected the overlay actually on the map'
		)
		assert.equal(tool._image_overlays.length, 1, 'expected the overlay tracked for teardown')
	})

	it('a coordinate-less image keeps its own aspect ratio and does not fill the viewport', function() {

		// v6 stretches the image onto map.getBounds(), which distorts every
		// image the moment the map is not square (a square plan lands as a
		// wide rectangle) and covers the whole map with something that cannot
		// be resized until "Activar edición" lands. Both deviations are
		// deliberate — image_upload.js corners_from_viewport.
		const viewport	= geolocation.map.getSize()
		assert.isAbove(viewport.x, 0, 'expected a laid-out map — every assertion below is in its pixels')
		assert.isAbove(viewport.y, 0, 'expected a laid-out map — every assertion below is in its pixels')
		const map_ratio	= viewport.x / viewport.y

		// a deliberately NON-square image, so a stretched result is unmissable
		const corners = corners_from_viewport(geolocation.map, {width: 400, height: 100})

		// measure back in CONTAINER PIXELS — degrees of lat and lon are not
		// the same length on screen, so a lat/lon comparison would prove nothing
		const to_point	= (c) => geolocation.map.latLngToContainerPoint(L.latLng(c[0], c[1]))
		const tl		= to_point(corners.top_left)
		const tr		= to_point(corners.top_right)
		const bl		= to_point(corners.bottom_left)
		const drawn_w	= tr.x - tl.x
		const drawn_h	= bl.y - tl.y

		assert.closeTo(drawn_w / drawn_h, 4, 0.05, 'expected the image\'s own 4:1 ratio preserved, not the map\'s')
		assert.isAbove(
			Math.abs(drawn_w / drawn_h - map_ratio), 0.05,
			'expected the image NOT stretched to the viewport ratio (the v6 bug this replaces)'
		)

		// half the shorter side, and centred
		assert.closeTo(drawn_w, Math.min(viewport.x, viewport.y) * 0.5, 1, 'expected half the shorter viewport side')
		assert.closeTo((tl.x + tr.x) / 2, viewport.x / 2, 1, 'expected horizontally centred')
		assert.closeTo((tl.y + bl.y) / 2, viewport.y / 2, 1, 'expected vertically centred')
	})

	it('create_image_object flags the object is_raster so the object viewer lists it as a raster', async function() {

		// the PRODUCTION builder, not a hand-made carrier: object_viewer.js
		// splits its two lists on properties.uca_maps.is_raster and its own
		// header names THIS row as what fills the raster one, so the flag has
		// to be written where the object is actually created
		const carrier = await create_image_object(tool, JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR)))

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

	it('create_image_object hands the carrier back ALREADY editable, as v6 does', async function() {

		// a plain image lands at an arbitrary spot, so the next gesture is
		// always moving it: v6 uploads straight into edit mode and making the
		// user find a checkbox first is a step it never asked for
		const descriptor = JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR))
		delete descriptor.interactive

		const carrier = await create_image_object(tool, descriptor)
		await settle_map(geolocation.map)

		assert.equal(
			carrier.feature.properties.uca_maps.image.interactive, true,
			'expected a new image to arrive with edit mode on'
		)
	})

	it('create_image_object never overrides an interactive flag the descriptor already carries', async function() {

		// the guard that keeps the default from becoming a rule: the builder
		// fills a MISSING flag, it does not decide for a caller that set one
		const descriptor = JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR))
		descriptor.interactive = false

		const carrier = await create_image_object(tool, descriptor)
		await settle_map(geolocation.map)

		assert.equal(carrier.feature.properties.uca_maps.image.interactive, false, 'expected the given flag kept')
	})

	it('the carrier is sealed from Geoman editing but still removable', async function() {

		// component_geolocation.js click handler calls layer.pm.enable() on
		// every layer of the clicked FeatureGroup — which painted four vertex
		// circles over the image, competing with this module's three handles.
		// Removal must survive: Geoman's remove tool is how an image is deleted
		const carrier = await create_image_object(tool, JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR)))
		await settle_map(geolocation.map)

		assert.equal(carrier.pm.options.allowEditing, false, 'expected Geoman editing refused on the carrier')
		assert.notEqual(carrier.pm.options.allowRemoval, false, 'expected Geoman removal still allowed')

		// and the enable() the component fires on click must be a no-op
		carrier.pm.enable()
		assert.equal(carrier.pm.enabled(), false, 'expected pm.enable() to leave the carrier un-edited')
	})

	it('dragging the carrier carries the picture, the handles and the stored corners with it', async function() {

		// Geoman's drag mode grabs the CARRIER — a transparent rectangle. Before
		// this the user dragged an invisible box and the image stayed behind:
		// the two desynced and nothing appeared to move (Sergio, validación
		// hito 14, 2ª ronda). v6 could not drag an image at all
		const carrier = await create_image_object(tool, JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR)))
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

		assert.closeTo(handles[0].getLatLng().lat, after.top_left[0], 1e-9, 'expected the handles moved too')
		assert.closeTo(handles[0].getLatLng().lng, after.top_left[1], 1e-9, 'expected the handles moved too')
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

		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		// let any racing rebuild finish before counting
		await new Promise((r) => setTimeout(r, 100))

		assert.equal(tool._image_overlays.length, 1, 'expected exactly one overlay, not a stacked duplicate')
	})

	it('hiding an uploaded image hides the picture, not just its carrier', async function() {

		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}

		apply_display(carrier, false)

		assert.equal(
			carrier._uca_maps_overlay._image.style.display, 'none',
			'expected the overlay hidden too — hiding only the transparent carrier would leave the picture painted and unselectable'
		)

		apply_display(carrier, true)
		assert.notEqual(carrier._uca_maps_overlay._image.style.display, 'none', 'expected it shown again')
	})

	it('the console shows an image carrier v6\'s sections: image controls, downloads and the properties block, never the geometry ones', async function() {

		const carrier = add_image_carrier()
		tool.attach_console()
		tool.attach_image_overlays()
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}

		// the carrier is built by hand here, so it carries no popup — fire the
		// selection event the console actually listens to (object_console.js
		// hydrate's 'popupopen' handler reads popup._source and nothing else)
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

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
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

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
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

		// a handle drag that nobody saved yet: the download must follow it
		image.corners.top_right = [40.47, -3.63]

		let sent = null
		const original = tool.tool_request
		tool.tool_request = async function(request) {
			sent = request
			return {ok: false, error: {code: 'request.invalid_options'}}
		}

		try {
			const download = tool.panel_node.querySelector('.uca-maps-image-download-section')
			download.querySelector('.uca-maps-image-download-quality').value = '2'
			download.querySelector('.uca-maps-image-download-format').value = 'jpg'
			download.querySelector('.uca-maps-image-download-button').click()
			for (let i=0; i<100 && !sent; i++) {
				await new Promise(r => setTimeout(r, 10))
			}

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
		} finally {
			tool.tool_request = original
		}
	})

	it('"Download image" saves what the server sends, under its name and type', async function() {

		const carrier = add_image_carrier()
		const original = tool.tool_request
		tool.tool_request = async function() {
			return {ok: true, data: {content_base64: btoa('x'), mime: 'image/png', filename: 'plan.png'}}
		}
		try {
			const captured = await capture_download(() => tool.download_image(carrier, 'png', 0.8, 'plan'))
			assert.equal(captured.name, 'plan.png', 'expected the server\'s file name on the anchor')
			assert.equal(captured.blob && captured.blob.type, 'image/png', 'expected the server\'s mime on the blob')
		} finally {
			tool.tool_request = original
		}
	})

	it('image_download_width is v6\'s quality over the fitted on-screen size, and never moves the map', function() {

		const map		= geolocation.map
		const corners	= JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR.corners))
		const center	= map.getCenter()
		const zoom		= map.getZoom()

		const one = image_download_width(map, corners, 1)
		assert.isAbove(one, 1)
		assert.closeTo(image_download_width(map, corners, 2), one * 2, 1, 'expected twice the pixels at "Excelente"')
		assert.closeTo(image_download_width(map, corners, 0.4), one * 0.4, 1)

		// fitted, not "as seen now": zooming the map changes nothing
		map.setZoom(zoom - 2, {animate: false})
		assert.equal(image_download_width(map, corners, 1), one, 'expected the same width at any current zoom')
		map.setView(center, zoom, {animate: false})
		assert.equal(map.getCenter().lat, center.lat, 'expected the map left where it was')
	})

	it('"Download image" with an empty name is refused without asking the server', async function() {

		const carrier = add_image_carrier()
		let asked = false
		const original = tool.tool_request
		tool.tool_request = async function() { asked = true; return {ok: false} }
		try {
			await tool.download_image(carrier, 'png', 0.8, '   ')
			assert.equal(asked, false, 'expected no request for an empty name')
		} finally {
			tool.tool_request = original
		}
	})

	it('"View image" is left out, not pointed at the bare file, when the descriptor names no record', function() {

		tool.attach_console()

		for (const missing of ['section_id', 'section_tipo']) {
			const carrier = add_image_carrier()
			delete carrier.feature.properties.uca_maps.image[missing]
			geolocation.map.fire('popupopen', {popup: {_source: carrier}})

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
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

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
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

		const slider = tool.panel_node.querySelector('.uca-maps-image-z-index')
		assert.equal(slider.type, 'range', 'expected a slider, as v6, not a number box')
		assert.equal(slider.min, '0')
		assert.equal(slider.max, '1000')
		// above 100 on purpose: with `value` set before `max` it would read 100
		assert.equal(slider.value, '640', 'expected the stored z-index, not a clamped one')

		let commits = 0
		const original = geolocation.update_draw_data
		geolocation.update_draw_data = function() { commits++; return original.apply(this, arguments) }

		try {
			slider.value = '850'
			slider.dispatchEvent(new Event('input'))
			assert.equal(carrier.feature.properties.uca_maps.image.z_index, 850, 'expected the preview written while dragging')
			assert.equal(carrier._uca_maps_overlay.options.zIndex, 850, 'expected the live overlay restacked while dragging')
			assert.equal(commits, 0, 'expected NO commit mid-drag')

			slider.dispatchEvent(new Event('change'))
			assert.equal(commits, 1, 'expected exactly one commit on release')
		} finally {
			geolocation.update_draw_data = original
		}
	})

	it('a z-index outside 0..1000 is bounded where it is used, so the slider and the overlay agree', async function() {

		// the old number box could store anything; nothing validated it
		const carrier = add_image_carrier()
		carrier.feature.properties.uca_maps.image.z_index = 1500
		tool.attach_console()
		tool.attach_image_overlays()
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

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
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}

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
		for (let i=0; i<200 && !stale._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		const stale_overlay = stale._uca_maps_overlay
		assert.equal(geolocation.map.hasLayer(stale_overlay), true, 'expected the first overlay on the map')

		// the reload: the old carrier is gone from the group, a new one takes
		// its place, and only the layer-data event announces it
		geolocation.FeatureGroup[geolocation.active_layer_id].removeLayer(stale)
		const fresh = add_image_carrier()
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})

		for (let i=0; i<200 && !fresh._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}

		assert.isOk(fresh._uca_maps_overlay, 'expected the new carrier to get its overlay')
		assert.equal(geolocation.map.hasLayer(stale_overlay), false, 'expected the stale overlay swept off the map')
		assert.equal(tool._image_overlays.length, 1, 'expected exactly one tracked overlay, not two stacked')
	})

	it('deleting the carrier takes its overlay off the map with it', async function() {

		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		const overlay = carrier._uca_maps_overlay

		geolocation.map.fire('pm:remove', {layer: carrier})

		assert.equal(geolocation.map.hasLayer(overlay), false, 'expected the orphaned image removed from the map')
		assert.equal(tool._image_overlays.length, 0, 'expected the overlay untracked')
	})

	it('teardown removes every overlay the tool put on the map', async function() {

		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		const overlay = carrier._uca_maps_overlay

		await tool.destroy(false, false, false)

		assert.equal(geolocation.map.hasLayer(overlay), false, 'expected the overlay removed on teardown')
	})

	// hito 14 — "Activar edición" (js/image_edit.js): the overlay's three
	// control points as draggable handles. Same carrier-by-hand approach as the
	// hito 13 block above, and the same reason: the browser half is all that
	// lives here.
	async function add_image_carrier_with_overlay() {
		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		for (let i=0; i<200 && !carrier._uca_maps_overlay; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		return carrier
	}

	it('the console offers "Activar edición" and it reflects the stored state', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.attach_console()
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

		const checkbox = tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-image-edit')
		assert.isOk(checkbox, 'expected the "Activar edición" checkbox in the image branch')
		assert.equal(checkbox.checked, false, 'expected edit mode off for a descriptor that never stored it')

		tool.set_image_interactive(carrier, true)
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})

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

		geolocation.update_draw_data = original
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
		for (let i=0; i<200 && !carrier._uca_maps_handles; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}

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

	it('teardown removes the handles as well as the overlay', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)
		const handles = carrier._uca_maps_handles.slice()

		await tool.destroy(false, false, false)

		for (const handle of handles) {
			assert.equal(
				geolocation.map.hasLayer(handle), false,
				'expected the handle removed on teardown — nothing else in the engine tracks it'
			)
		}
	})

	it('deleting the object removes its handles too', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)
		const handles = carrier._uca_maps_handles.slice()

		geolocation.map.fire('pm:remove', {layer: carrier})

		for (const handle of handles) {
			assert.equal(geolocation.map.hasLayer(handle), false, 'expected the handle removed with its object')
		}
	})


	/**
	* HITO 15 — the three always-present controls (audit rows #1 "Buscador de
	* lugares", #13 "Geolocation", #2 "Barra de escala").
	*
	* The place search NEVER reaches nominatim.openstreetmap.org from a test:
	* `tool_request` is stubbed with a hand-written envelope, the same way the
	* PNG capture test above stubs it to prove the opposite (no round-trip).
	* A gate that needs a third party to be up is a gate that goes red for
	* reasons that have nothing to do with this code.
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
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { asked = true; return {} }

		const result = await search_places(tool, '   ')

		assert.equal(result.ok, false, 'expected a caller-fault verdict')
		assert.isOk(result.error, 'expected a message to show in the panel')
		assert.equal(asked, false, 'expected NO request for an empty query')

		tool.tool_request = original_tool_request
	})

	it('search_places stores the hits and the panel renders one clickable row each', async function() {

		tool.attach_place_search()

		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			assert.equal(options.action, 'search_places')
			assert.equal(options.options.query, 'Sagunto')
			return { ok: true, data: { results: [
				{ name: 'Sagunt', point: [39.68, -0.27], bbox: [39.6, -0.35, 39.75, -0.2] },
				{ name: 'Sagunto, Spain', point: [39.67, -0.28], bbox: null }
			] } }
		}

		const result = await search_places(tool, ' Sagunto ')
		assert.equal(result.ok, true)
		assert.equal(result.results.length, 2)

		// the panel's own render path (render_place_search.js), reached the
		// way the Search button reaches it
		populate_place_search_results(tool, tool.place_search_panel)
		const rows = tool.place_search_panel.querySelectorAll('.uca-maps-place-search-result-button')
		assert.equal(rows.length, 2, 'expected one row per hit')
		assert.equal(rows[0].textContent, 'Sagunt')

		tool.tool_request = original_tool_request
	})

	it('focus_place_result fits the bounding box, and falls back to a point zoom without one', async function() {

		tool.attach_place_search()
		tool._place_results = [
			{ name: 'with bbox', point: [39.68, -0.27], bbox: [39.6, -0.35, 39.75, -0.2] },
			{ name: 'no bbox', point: [40.0, -1.0], bbox: null }
		]

		assert.equal(focus_place_result(tool, 0), true)
		const bounds = geolocation.map.getBounds()
		assert.isTrue(bounds.contains(L.latLng(39.68, -0.27)), 'expected the map moved onto the hit')

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

		const original_tool_request = tool.tool_request
		tool.tool_request = async function() {
			return { ok: true, data: { results: [{ name: 'Sagunt', point: [39.68, -0.27], bbox: null }] } }
		}

		try {
			const search = async (text) => {
				input.value = text
				panel.querySelector('.uca-maps-place-search-button').click()
				await new Promise(resolve => setTimeout(resolve, 0))
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
		} finally {
			tool.tool_request = original_tool_request
		}
	})

	it('reopening Search mid-search keeps its query, and the answer still lands', async function() {

		tool.attach_place_search()

		const panel		= tool.place_search_panel
		const toggle	= () => tool.place_search_control.getContainer().click()
		const input		= panel.querySelector('.uca-maps-place-search-input')
		const button	= panel.querySelector('.uca-maps-place-search-button')

		let settle = null
		const original_tool_request = tool.tool_request
		tool.tool_request = function() {
			return new Promise((resolve) => { settle = resolve })
		}

		try {
			toggle()
			input.value = 'Sagunto'
			button.click()
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.isOk(settle, 'expected the search in flight')

			toggle()
			toggle()
			assert.equal(input.value, 'Sagunto', 'expected the query kept while the search runs')

			settle({ ok: true, data: { results: [{ name: 'Sagunt', point: [39.68, -0.27], bbox: null }] } })
			await new Promise(resolve => setTimeout(resolve, 0))
			assert.equal(panel.querySelectorAll('.uca-maps-place-search-result-button').length, 1, 'expected the late hit listed')
			assert.equal(button.disabled, false)
		} finally {
			tool.tool_request = original_tool_request
		}
	})

	it('detach_place_search removes the button and panel', async function() {

		tool.attach_place_search()
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.place_search_control, null, 'expected place_search_control cleared')
		assert.equal(tool.place_search_panel, null, 'expected place_search_panel cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-place-search-control'),
			'expected the button removed from the DOM'
		)
	})

	it('attach_geolocate adds exactly one button and no panel, idempotently', function() {

		tool.attach_geolocate()
		tool.attach_geolocate()

		const map_container_node = geolocation.map.getContainer()
		assert.equal(map_container_node.querySelectorAll('.uca-maps-geolocate-control').length, 1)
		assert.equal(is_geolocate_enabled(tool), false, 'expected it to start disarmed')
	})

	it('toggling geolocation arms it, and toggling again cancels the lookup', function() {

		tool.attach_geolocate()

		let located = 0
		let stopped = 0
		const original_locate		= geolocation.map.locate
		const original_stop_locate	= geolocation.map.stopLocate
		geolocation.map.locate		= function() { located++; return this }
		geolocation.map.stopLocate	= function() { stopped++; return this }

		toggle_geolocate(tool)
		assert.equal(is_geolocate_enabled(tool), true, 'expected the button armed')
		assert.equal(located, 1, 'expected the browser lookup started')

		toggle_geolocate(tool)
		assert.equal(is_geolocate_enabled(tool), false, 'expected the button disarmed')
		assert.equal(stopped, 1, 'expected an in-flight lookup cancelled, not left running')

		geolocation.map.locate		= original_locate
		geolocation.map.stopLocate	= original_stop_locate
	})

	it('a position fix drops ONE marker in the active layer and marks the record dirty — never saves', function() {

		tool.attach_geolocate()

		// two dirty marks, both legitimate and neither a save: the core's own
		// 'pm:create' handler calls update_draw_data when it adds the layer
		// (component_geolocation.js:1958), and commit() calls it again after
		// the tool has finished writing its own properties onto the feature.
		// What matters is that NOTHING here reaches the save door — the user's
		// own Save button stays the only writer (second law of
		// component_geolocation).
		let commits = 0
		let saves = 0
		const original_update	= geolocation.update_draw_data
		const original_save		= geolocation.save
		geolocation.update_draw_data	= function() { commits++; return original_update.apply(this, arguments) }
		geolocation.save				= function() { saves++ }

		const before = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length

		const marker = create_position_marker(tool, L.latLng(40.44, -3.70))

		assert.isOk(marker, 'expected a marker created')
		const after = geolocation.FeatureGroup[geolocation.active_layer_id].getLayers().length
		assert.equal(after, before + 1, 'expected exactly one new object in the active layer')
		assert.isAbove(commits, 0, 'expected the record marked dirty')
		assert.equal(saves, 0, 'expected NO save — nothing here writes')

		geolocation.update_draw_data	= original_update
		geolocation.save				= original_save
	})

	it('a second locationfound while disarmed drops nothing — v6 re-binds a listener per click and drops N markers', function() {

		tool.attach_geolocate()

		const group		= geolocation.FeatureGroup[geolocation.active_layer_id]
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
		const map_container_node	= geolocation.map.getContainer()
		const group					= geolocation.FeatureGroup[geolocation.active_layer_id]
		const before				= group.getLayers().length

		await tool.destroy(false, false, false)

		assert.equal(tool.geolocate_control, null, 'expected geolocate_control cleared')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-geolocate-control'))

		// destroy() nulls self.geolocation, so the handler would throw if it
		// were still bound — firing proves it is really off the map
		geolocation.map.fire('locationfound', {latlng: L.latLng(40.44, -3.70)})
		assert.equal(group.getLayers().length, before, 'expected a torn-down tool to ignore the map entirely')
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

	it('attach_scale_bar adds exactly one graphic scale WITH its compass rose, idempotently', function() {

		tool.attach_scale_bar()
		tool.attach_scale_bar()

		const map_container_node = geolocation.map.getContainer()
		const scales = map_container_node.querySelectorAll('.uca-maps-scale')
		assert.equal(scales.length, 1, 'expected exactly one scale bar')

		// the compass is half of what v6 draws here (its hand-patched copy of
		// leaflet-graphicscale builds one) — a scale bar without it is the
		// omission Sergio caught on the hito-15 validation
		assert.isOk(scales[0].querySelector('.uca-maps-scale-compass'), 'expected the compass rose')

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
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.scale_control, null, 'expected scale_control cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-scale'),
			'expected the scale bar removed on teardown'
		)
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

	it('the legend overlay is map CONTENT, not tool chrome — so it stays in the exported image', function() {

		tool.attach_legend()

		// `map_image_download.js` excludes every node registered through
		// toolbar.js from the screenshot. The editing panel and its button are
		// chrome and belong out; the legend itself is the one thing a user
		// exports a map WITH, so it must not be registered (hito 17 decision).
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

		// the corner itself is the decision (hito 17): 'topleft' is this tool's
		// own button column, 'topright' Geoman's draw bar, 'bottomright' the
		// scale bar — a legend stacked under the buttons is not the same design
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
		assert.equal(element_node.querySelector('img').getAttribute('src'), DEFAULT_ELEMENT_ICON)

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

	it('an icon must be an allowed type under 2 MB; a good one lands as a data URL', async function() {

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

		// the ceiling is v6's, inclusive: a file AT 2 MB is accepted — without
		// this case a `>` turned into a `>=` reads as green
		const at_the_ceiling = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array(MAX_ICON_BYTES)], 'exact.png', {type: 'image/png'})
		)
		assert.isTrue(at_the_ceiling.ok, 'expected a file exactly at the 2 MB ceiling accepted')
		tool.legend.columns[0].elements[0].icon = DEFAULT_ELEMENT_ICON

		assert.equal(
			tool.legend.columns[0].elements[0].icon, DEFAULT_ELEMENT_ICON,
			'expected a refused icon to leave the pin in place'
		)

		const accepted = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array([137, 80, 78, 71])], 'pin.png', {type: 'image/png'})
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

		// NOT a Blob: FileReader.readAsDataURL would THROW on it. So this only
		// returns a refusal if both checks happen before the read — a refactor
		// that reads first (loading a 30 MB file into memory just to throw it
		// away) turns this red instead of staying quietly green
		const not_readable = {type: 'application/pdf', size: 10, name: 'plan.pdf'}
		const by_type = await tool.set_legend_element_icon(0, 0, not_readable)
		assert.isFalse(by_type.ok, 'expected the type refused without reading')

		const oversized = {type: 'image/png', size: MAX_ICON_BYTES + 1, name: 'big.png'}
		const by_size = await tool.set_legend_element_icon(0, 0, oversized)
		assert.isFalse(by_size.ok, 'expected the size refused without reading')

		assert.equal(tool.legend.columns[0].elements[0].icon, DEFAULT_ELEMENT_ICON)
	})

	it('the panel edits the same legend the overlay draws', function() {

		tool.attach_legend()

		// open it the way a user does — populate_legend_columns only runs on show
		tool.legend_control.getContainer().click()

		const panel = tool.legend_panel
		assert.isFalse(panel.hidden, 'expected the panel open')
		assert.isOk(panel.querySelector('.uca-maps-legend-empty'), 'expected the empty-state line')

		const title_input = panel.querySelector('.uca-maps-legend-title-input')
		title_input.value = 'Simbología'
		title_input.dispatchEvent(new Event('input'))
		assert.equal(tool.legend.legend, 'Simbología', 'expected typing to reach the legend')

		panel.querySelector('.uca-maps-legend-add-column').click()
		assert.equal(panel.querySelectorAll('.uca-maps-legend-column').length, 1)
		assert.isNotOk(panel.querySelector('.uca-maps-legend-empty'), 'expected the empty-state line gone')

		panel.querySelector('.uca-maps-legend-add-element').click()
		assert.equal(panel.querySelectorAll('.uca-maps-legend-element').length, 1)

		const show_checkbox = panel.querySelector('.uca-maps-legend-show')
		assert.isTrue(show_checkbox.checked, 'expected the legend shown by default, as in v6')
		show_checkbox.checked = false
		show_checkbox.dispatchEvent(new Event('change'))
		assert.isFalse(tool.legend.enable, 'expected the checkbox to reach the legend')

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
		assert.equal(row.querySelector('img').getAttribute('src'), DEFAULT_ELEMENT_ICON)
		assert.isOk(row.querySelector('.uca-maps-legend-upload-icon'), 'expected the icon button')
	})

	it('a refused icon reaches the panel, and an accepted one repaints the row', async function() {

		tool.attach_legend()
		tool.legend_control.getContainer().click()

		const panel = tool.legend_panel
		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		// the message node and show_legend_message are coupled BY CLASS across
		// two files: renaming one side alone would throw inside the file-picker
		// handler and swallow every icon refusal silently
		const message = panel.querySelector('.uca-maps-legend-message')
		assert.isOk(message, 'expected the panel to carry its message line')
		assert.isTrue(message.hidden, 'expected it hidden while nothing failed')

		show_legend_message(panel, 'nope')
		assert.isFalse(message.hidden, 'expected a refusal shown')
		assert.equal(message.textContent, 'nope')

		const accepted = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array([137, 80, 78, 71])], 'pin.png', {type: 'image/png'})
		)
		assert.isTrue(accepted.ok)

		// the icon path is the one mutation that repaints the LIST, not just
		// the overlay (a new icon has to show in the row that uploaded it)
		populate_legend_columns(tool, panel)
		assert.isTrue(
			panel.querySelector('.uca-maps-legend-element img').getAttribute('src').startsWith('data:image/png;base64,'),
			'expected the row repainted with the uploaded icon'
		)
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
		// its own toggle (toolbar.js close_other_toolbar_panels) — a cached
		// "is open" flag would desync here and the next click would do nothing.
		// This is the bug CLAUDE.local.md records as already real once.
		button.click()
		assert.isFalse(tool.legend_panel.hidden, 'expected it open again')
		tool.xyz_control.getContainer().click()
		assert.isTrue(tool.legend_panel.hidden, 'expected the sibling to have closed it')
		button.click()
		assert.isFalse(tool.legend_panel.hidden, 'expected one click to reopen it')
	})

	/** The SVG a drawn legend symbol stores in `icon` (a base64 `data:` URL). */
	const decode_symbol = function(icon) {
		const prefix = 'data:image/svg+xml;base64,'
		assert.isTrue(icon.startsWith(prefix), 'expected a drawn symbol stored as an SVG data URL')
		return new DOMParser().parseFromString(atob(icon.slice(prefix.length)), 'image/svg+xml').documentElement
	}

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
			{shape: 'star', fill: PICKED_COLOUR, stroke: PICKED_COLOUR},
			{shape: 'area', fill: PICKED_COLOUR.slice(1), stroke: PICKED_COLOUR},
			{shape: 'area', fill: PICKED_COLOUR, stroke: '"/><script>x</script>'},
			// String([x]) === x: a coercing check would pass it and then throw
			{shape: 'area', fill: [PICKED_COLOUR], stroke: PICKED_COLOUR},
			null
		]) {
			assert.deepEqual(tool.set_legend_element_symbol(0, 0, bad), {ok: false})
		}
		assert.equal(element.icon, DEFAULT_ELEMENT_ICON, 'expected a refused symbol to leave the pin')
		assert.notProperty(element, 'symbol')
		assert.deepEqual(tool.set_legend_element_symbol(0, 7, {shape: 'area', fill: PICKED_COLOUR, stroke: PICKED_COLOUR}), {ok: false})

		assert.deepEqual(tool.set_legend_element_symbol(0, 0, {shape: 'area', fill: PICKED_COLOUR, stroke: DEFAULT_SYMBOL_COLOUR}), {ok: true})
		const rect = decode_symbol(element.icon).querySelector('rect')
		assert.isOk(rect, 'expected an area drawn as a rectangle')
		assert.equal(rect.getAttribute('fill'), PICKED_COLOUR)
		assert.equal(rect.getAttribute('stroke'), DEFAULT_SYMBOL_COLOUR)
		assert.deepEqual(element.symbol, {shape: 'area', fill: PICKED_COLOUR, stroke: DEFAULT_SYMBOL_COLOUR}, 'expected the values kept to reopen the editor')
		assert.equal(tool.legend_overlay.getContainer().querySelector('.uca-maps-legend-overlay-element img').getAttribute('src'), element.icon, 'expected the overlay to draw it')

		tool.set_legend_element_symbol(0, 0, {shape: 'area', fill: PICKED_COLOUR.toUpperCase(), stroke: PICKED_COLOUR})
		assert.equal(element.symbol.fill, PICKED_COLOUR, 'expected the colour stored lowercase')

		tool.set_legend_element_symbol(0, 0, {shape: 'line', fill: PICKED_COLOUR, stroke: PICKED_COLOUR})
		const line = decode_symbol(element.icon).querySelector('line')
		assert.isOk(line, 'expected a line drawn as a line')
		assert.isNull(line.getAttribute('fill'), 'expected a line with no fill')

		tool.set_legend_element_symbol(0, 0, {shape: 'point', fill: PICKED_COLOUR, stroke: PICKED_COLOUR})
		assert.isOk(decode_symbol(element.icon).querySelector('circle'), 'expected a point drawn as a circle')

		// an uploaded image replaces the drawn symbol
		const uploaded = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array([137, 80, 78, 71])], 'pin.png', {type: 'image/png'})
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
		assert.equal(row_icon.getAttribute('src'), DEFAULT_ELEMENT_ICON, 'expected the pin inside the symbol button')
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
		fill_input.value = PICKED_COLOUR
		fill_input.dispatchEvent(new Event('input'))
		assert.equal(element.symbol.fill, PICKED_COLOUR, 'expected the fill to reach the symbol')
		assert.isTrue(fill_input.isConnected, 'expected the colour input kept')
		assert.isFalse(editor.hidden, 'expected the editor still open')
		assert.equal(decode_symbol(row_icon.getAttribute('src')).querySelector('rect').getAttribute('fill'), PICKED_COLOUR)

		const stroke_label = editor.querySelector('.uca-maps-legend-symbol-stroke').closest('label').querySelector('.uca-maps-legend-field-label')
		const border_text = stroke_label.textContent
		editor.querySelector('[data-shape="line"]').click()
		assert.isTrue(fill_input.closest('label').hidden, 'expected no fill for a line')
		assert.notEqual(stroke_label.textContent, border_text, 'expected the one line colour not called a border')
		assert.equal(element.symbol.fill, PICKED_COLOUR, 'expected the fill kept for a later area or point')

		// a rebuilt list reopens the editor on the STORED symbol, not the defaults
		populate_legend_columns(tool, panel)
		const rebuilt = panel.querySelector('.uca-maps-legend-symbol-editor')
		assert.notEqual(rebuilt, editor, 'expected a fresh editor')
		assert.equal(rebuilt.querySelector('[data-shape="line"]').getAttribute('aria-pressed'), 'true', 'expected the stored shape pressed')
		assert.equal(rebuilt.querySelector('.uca-maps-legend-symbol-fill').value, PICKED_COLOUR, 'expected the stored fill')
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
	})

	/**
	* HITO 18 — "Roma" (fila #14, roman_empire.js): three gazetteers searched
	* from one centred panel, and the hit becomes a REAL object of the record.
	*
	* No gazetteer is ever reached from a test: `tool_request`/
	* `get_capabilities` are stubbed with hand-written envelopes, same as the
	* place-search block above. A gate that needs Pleiades or Lund University
	* to be up is a gate that goes red for reasons unrelated to this code.
	*/

	/** A one-point GeoJSON feature, the shape Pelagios/DARE hits carry. */
	const roman_feature = function(name, lat, lon) {
		return {
			type		: 'Feature',
			properties	: { name: name },
			geometry	: { type: 'Point', coordinates: [lon, lat] }
		}
	}

	it('attach_roman_empire adds exactly one button and one hidden panel, idempotently', function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }

		tool.attach_roman_empire()
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

		// Sergio, validación 2026-09-28: como Legend y WMS, y las tres fuentes
		// a la vez, como el modal de v6 — nunca un selector que esconda dos
		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		const panel = tool.roman_panel
		assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), 'expected the centred panel')
		assert.isNotOk(panel.querySelector('.uca-maps-roman-source-select'), 'expected no source selector')

		const sections = Array.from(panel.querySelectorAll('.uca-maps-roman-source'))
		assert.deepEqual(sections.map((one) => one.dataset.source), ROMAN_SOURCES, 'expected Pleiades, Pelagios, DARE')
		for (const section of sections) {
			assert.equal(section.hidden, false, 'expected every source visible: ' + section.dataset.source)
			assert.equal(section.querySelectorAll('.uca-maps-roman-input').length, 1, 'expected one field per source')
		}

		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		assert.equal(panel.hidden, false)
		panel.querySelector('.uca-maps-panel-close').click()
		assert.equal(panel.hidden, true, 'expected × to close the panel')
	})

	it('Pleiades picks name or id with two radios, and the choice reaches the search', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool) // Pleiades enabled BEFORE it is driven

		const section	= tool.roman_panel.querySelector('.uca-maps-roman-pleiades')
		const radios	= section.querySelectorAll('.uca-maps-roman-pleiades-type input[type="radio"]')
		assert.equal(radios.length, 2, 'expected two radios, not a select')
		assert.isNotOk(section.querySelector('select'), 'expected no select in the Pleiades section')
		assert.equal(radios[0].name, radios[1].name, 'expected ONE radio group')
		assert.equal(radios[0].value, 'name')
		assert.isTrue(radios[0].checked, 'expected "by name" chosen by default, as in v6')

		const sent = []
		tool.tool_request = async function(options) {
			sent.push(options)
			return { ok: true, data: { results: [] } }
		}

		radios[1].click()
		const input = section.querySelector('.uca-maps-roman-input')
		assert.isFalse(input.disabled, 'expected the Pleiades field enabled by its capability')
		input.value = '7'
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(sent.length, 1, 'expected one search: an id of one digit is a query')
		assert.equal(sent[0].action, 'search_pleiades')
		assert.equal(sent[0].options.type, 'id', 'expected the checked radio forwarded')
	})

	it('search_roman refuses an empty query, and Pelagios with no layer, without asking the server', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		let asked = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function() { asked = true; return {} }

		const empty = await search_roman(tool, 'pleiades', { query: '   ' })
		assert.equal(empty.ok, false, 'expected a caller-fault verdict')
		assert.isOk(empty.error, 'expected a message to show in the panel')

		const no_layer = await search_roman(tool, 'pelagios', { query: 'Gades', datasets: [] })
		assert.equal(no_layer.ok, false, 'expected Pelagios with no layer refused')
		assert.isOk(no_layer.error)

		assert.equal(asked, false, 'expected NO request in either case')

		tool.tool_request = original_tool_request
	})

	it('each source sends its OWN action and its own fields', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		const sent = []
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			sent.push(options)
			return { ok: true, data: { results: [] } }
		}

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

		tool.tool_request = original_tool_request
	})

	it('the hits render one clickable row each, and a row DRAWS the place on the map', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		// open: a list never shows over a closed panel
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

		const original_tool_request = tool.tool_request
		tool.tool_request = async function() {
			return { ok: true, data: { results: [
				{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.53, -6.29) },
				{ name: 'Gadir', geometry_type: 'Point', feature: roman_feature('Gadir', 36.54, -6.30) }
			] } }
		}

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
		const feature_group	= geolocation.FeatureGroup[geolocation.active_layer_id]
		const before		= feature_group.getLayers().length
		const added			= await add_roman_result(tool, 0)
		assert.equal(added.ok, true, 'expected the place added')
		assert.equal(added.created, 1, 'expected exactly one layer created')
		assert.equal(
			feature_group.getLayers().length, before + 1,
			'expected one more object in the active FeatureGroup'
		)

		tool.tool_request = original_tool_request
	})

	it('a hit whose geometry Leaflet cannot build is reported, never a silent success', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		tool._roman_results = [{ name: 'no geometry', feature: { type: 'Feature', properties: {}, geometry: null } }]
		const added = await add_roman_result(tool, 0)

		assert.equal(added.ok, false, 'expected a failure verdict')
		assert.isOk(added.error, 'expected a message for the panel')
	})

	it('a Pleiades hit carries only an id, so its geometry is fetched before drawing', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		const original_tool_request = tool.tool_request
		let asked_action = null
		tool.tool_request = async function(options) {
			asked_action = options.action
			assert.equal(options.options.id, '256135', 'expected the hit id forwarded')
			return { ok: true, data: { place: {
				type		: 'FeatureCollection',
				features	: [roman_feature('Gades', 36.53, -6.29)]
			} } }
		}

		tool._roman_results = [{ name: 'Gades', id: '256135' }]
		const added = await add_roman_result(tool, 0)

		assert.equal(asked_action, 'get_pleiades_place', 'expected the geometry fetched by id')
		assert.equal(added.ok, true)
		assert.equal(added.created, 1)

		tool.tool_request = original_tool_request
	})

	it('create_roman_objects fits the LARGEST geometry of a multi-part place', function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		const created = create_roman_objects(tool, { type: 'FeatureCollection', features: [
			{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } },
			{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]] } }
		] })

		assert.equal(created, 2, 'expected both parts created')
		const bounds = geolocation.map.getBounds()
		assert.isTrue(bounds.contains(L.latLng(11, 11)), 'expected the map fitted to the bigger part')
	})

	it('a source this install cannot serve stays in view, disabled and saying why', function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

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

		tool.get_capabilities = async function() {
			return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] } } }
		}
		tool.attach_roman_empire()

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

	// SUGGESTIONS AS YOU TYPE — v6 searches on every keyup in all three blocks
	// (`special_tools_roman_empire.js:215/785/1286`). Sergio, validación
	// 2026-09-17: el port solo buscaba con el botón/Enter.

	it('each source declares the same minimum the server refuses below', function() {

		assert.equal(roman_min_query('pleiades', 'name'), 3, 'Pleiades by name: 3 (v6 strlen > 2)')
		assert.equal(roman_min_query('pleiades', 'id'), 1, 'an id is exact, one digit is a query')
		assert.equal(roman_min_query('pelagios'), 2, 'Pelagios: 2 (v6 strlen >= 2)')
		assert.equal(roman_min_query('dare'), 3, 'DARE: 3 (v6 strlen >= 3)')
	})

	it('typing searches by itself, and below the minimum nothing travels', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click() // a list shows only over an open panel

		let asked = 0
		tool.tool_request = async function() {
			asked++
			return { ok: true, data: { results: [
				{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.53, -6.29) }
			] } }
		}

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')

		// below the minimum: no request, not even after the debounce window
		input.value = 'Ga'
		input.dispatchEvent(new Event('input'))
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 0, 'expected NO request for a query under the minimum')

		// at the minimum: one request, and the list renders itself
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))
		await new Promise((resolve) => setTimeout(resolve, 400))

		assert.equal(asked, 1, 'expected exactly one request after typing')
		assert.equal(
			tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button').length, 1,
			'expected the suggestion rendered without pressing anything'
		)
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open by itself')
	})

	it('a burst of keystrokes is ONE request, not one per character (v6 fires per keyup)', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		let asked = 0
		tool.tool_request = async function() {
			asked++
			return { ok: true, data: { results: [] } }
		}

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		for (const value of ['Gad', 'Gade', 'Gades', 'Gadesx']) {
			input.value = value
			input.dispatchEvent(new Event('input'))
			await new Promise((resolve) => setTimeout(resolve, 40))
		}
		await new Promise((resolve) => setTimeout(resolve, 400))

		assert.equal(asked, 1, 'expected the burst collapsed into a single request')
	})

	it('a slow early search never overwrites the results of the last one typed', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		let release_first
		let call = 0
		tool.tool_request = function() {
			call++
			if (call===1) {
				return new Promise((resolve) => { release_first = () => resolve({ ok: true, data: { results: [
					{ name: 'STALE', geometry_type: 'Point', feature: roman_feature('STALE', 0, 0) }
				] } }) })
			}
			return Promise.resolve({ ok: true, data: { results: [
				{ name: 'FRESH', geometry_type: 'Point', feature: roman_feature('FRESH', 1, 1) }
			] } })
		}

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

	// THE TYPEAHEAD ITSELF (Sergio, 2026-09-17): the hits are a list anchored to
	// the field, not a block inside the panel — and choosing one IS adding it.

	it('the suggestion list hangs from the MAP, not from the panel (the panel would clip it)', function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		const map_container_node = geolocation.map.getContainer()
		assert.isOk(tool.roman_dropdown, 'expected the list built')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected it closed until something is typed')
		assert.equal(tool.roman_dropdown.parentNode, map_container_node, 'expected it parented to the map container')
		assert.isNotOk(
			tool.roman_panel.querySelector('.uca-maps-roman-dropdown'),
			'expected it OUTSIDE the panel, whose overflow would clip it'
		)
		// and the panel no longer carries a Search button or an in-flow list
		assert.isNotOk(tool.roman_panel.querySelector('.uca-maps-roman-search-button'), 'expected no Search button')
		assert.isNotOk(tool.roman_panel.querySelector('.uca-maps-roman-results'), 'expected no in-flow result list')
	})

	it('the arrows walk the list and Enter draws the highlighted place', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click() // a list shows only over an open panel

		tool.tool_request = async function() {
			return { ok: true, data: { results: [
				{ name: 'first', geometry_type: 'Point', feature: roman_feature('first', 36.5, -6.2) },
				{ name: 'second', geometry_type: 'Point', feature: roman_feature('second', 39.9, -0.2) }
			] } }
		}

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))
		await new Promise((resolve) => setTimeout(resolve, 400))

		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')
		assert.equal(rows.length, 2)
		assert.equal(tool._roman_active_index, -1, 'expected nothing highlighted until the user walks the list')

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 1, 'expected the second row highlighted')
		assert.isTrue(rows[1].classList.contains('is-active'), 'expected the highlight in the DOM, not only in a flag')

		const feature_group	= geolocation.FeatureGroup[geolocation.active_layer_id]
		const before		= feature_group.getLayers().length

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(feature_group.getLayers().length, before + 1, 'expected Enter to draw the highlighted place')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed after choosing')
	})

	it('Escape closes the list without clearing what was typed', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click() // a list shows only over an open panel

		tool.tool_request = async function() {
			return { ok: true, data: { results: [
				{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }
			] } }
		}

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(tool.roman_dropdown.hidden, false)

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))

		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed')
		assert.equal(input.value, 'Gades', 'expected the typed text untouched')
		assert.equal(tool._roman_active_index, -1, 'expected the highlight forgotten')
	})

	it('a click on the map closes the list, and closing the panel takes it with it', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		const map_container_node = geolocation.map.getContainer()
		map_container_node.querySelector('.uca-maps-roman-control').click() // open the panel, as a user would
		tool._roman_results = [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }]
		tool._roman_source	= 'dare' // seeded AFTER opening: opening resets the panel

		populate_roman_results(tool, tool.roman_panel)
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

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		let asked = 0
		tool.tool_request = async function() { asked++; return { ok: true, data: { results: [] } } }

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))

		await tool.destroy(false, false, false) // BEFORE the debounce window elapses
		await new Promise((resolve) => setTimeout(resolve, 400))

		assert.equal(asked, 0, 'expected the pending search cancelled by teardown')
	})

	it('the twelve Pelagios layers fit in the panel WITHOUT an inner scroll', async function() {

		// Sergio, validación 2026-09-17: con el cap de 9rem había que hacer
		// scroll para ver la mitad de las capas. Esto lo mide de verdad — un
		// retoque de CSS que vuelva a esconderlas pone el gate en rojo.
		tool.get_capabilities = async function() {
			return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [
				'places_high', 'places_medium', 'places_low', 'places_subsites',
				'fortifications', 'provinces', 'provinces_label', 'roads_high',
				'roads_low', '10m_lakes', '10m_lakes_label', '10m_rivers_lake_centerlines'
			] } } }
		}
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)

		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click() // open it

		const container	= tool.roman_panel.querySelector('.uca-maps-roman-datasets')
		const rows		= container.querySelectorAll('.uca-maps-roman-dataset-row')
		assert.equal(rows.length, 12, 'expected the twelve layers rendered')

		assert.isAtMost(
			container.scrollHeight, container.clientHeight + 1,
			'expected every layer visible without scrolling inside the list'
		)
		// and each row on one line: a wrapped identifier reads as two layers
		for (const row of rows) {
			assert.isBelow(row.scrollWidth, row.clientWidth + 2, 'expected the layer name on a single line: ' + row.textContent)
		}
	})

	it('scrolling the panel carries the list with its field, and closes it once the field leaves the view', function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel = tool.roman_panel
		panel.style.maxHeight	= '160px' // the suite has no tool CSS: make the panel scroll
		panel.style.overflowY	= 'auto'
		tool._roman_results	= [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }]
		tool._roman_source	= 'dare' // seeded AFTER opening: opening resets the panel

		// DARE's field in the middle of the view, then the list opened under it
		const input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		panel.scrollTop += input.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 2
		populate_roman_results(tool, panel)
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

	// review-diff 2026-09-29: hiding a message at the panel's bottom makes the
	// browser clamp scrollTop and fire `scroll` — which closed the list it had
	// just opened, and (R-05) dropped the search in flight
	it('a scroll the layout causes by itself never closes the list it just opened', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel = tool.roman_panel
		panel.style.maxHeight	= '160px'
		panel.style.overflowY	= 'auto'

		const block		= panel.querySelector('.uca-maps-roman-dare')
		const input		= block.querySelector('.uca-maps-roman-input')
		const message	= block.querySelector('.uca-maps-roman-message')
		tool.tool_request = async function() {
			return { ok: true, data: { results: [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }] } }
		}

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})) // empty: an error under DARE
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(message.hidden, false, 'expected the empty-query message under DARE')

		panel.scrollTop = panel.scrollHeight // at the bottom: hiding that message has to clamp
		const bottom = panel.scrollTop
		let scrolls = 0
		panel.addEventListener('scroll', () => scrolls++)

		input.value = 'Gades'
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await new Promise((resolve) => setTimeout(resolve, 50))
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

		assert.equal(message.hidden, true, 'expected the message cleared by the hits')
		assert.isBelow(panel.scrollTop, bottom, 'expected the browser to clamp scrollTop — else this gate proves nothing')
		assert.isAbove(scrolls, 0, 'expected the clamp to fire scroll — else this gate proves nothing')
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list still open after the layout scroll')
	})

	// Sergio, validación 2026-09-29: the list stayed open under Pleiades after
	// clicking into DARE — the panel swallows mousedown before it bubbles
	it('a click inside the panel, on another source\'s field, closes the list', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool) // Pleiades enabled BEFORE it is driven
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		tool._roman_results	= [{ name: 'Roma', id: '423025' }]
		tool._roman_source	= 'pleiades' // seeded AFTER opening: opening resets the panel
		populate_roman_results(tool, tool.roman_panel)

		const own_input		= tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const other_input	= tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')

		own_input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, false, 'expected a click in the list\'s own field to keep it open')

		other_input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a click in another source\'s field to close it')
	})

	it('a search still in flight never opens its list once the user has moved to another field', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click() // open: a closed panel hides any list anyway

		let release_first
		tool.tool_request = function() {
			return new Promise((resolve) => { release_first = () => resolve({ ok: true, data: { results: [
				{ name: 'Roma', id: '423025' }
			] } }) })
		}

		const pleiades_input	= tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')

		pleiades_input.value = 'Rom'
		pleiades_input.dispatchEvent(new Event('input'))
		await new Promise((resolve) => setTimeout(resolve, 400)) // the Pleiades search is now in flight

		dare_input.value = 'V' // below DARE's minimum: nothing travels, the list is closed
		dare_input.dispatchEvent(new Event('input'))

		release_first()
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(tool.roman_dropdown.hidden, true, 'expected the late Pleiades answer NOT to open its list')
		assert.equal(tool._roman_results, null, 'expected the late answer discarded')
	})

	it('a search refused before travelling still outdates the older one in flight', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()

		let release_first
		tool.tool_request = function() {
			return new Promise((resolve) => { release_first = () => resolve({ ok: true, data: { results: [
				{ name: 'STALE', geometry_type: 'Point', feature: roman_feature('STALE', 0, 0) }
			] } }) })
		}

		const first		= search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' })
		const refused	= await search_roman(tool, 'pelagios', { query: 'Gadir', datasets: [] })
		assert.equal(refused.ok, false, 'expected Pelagios with no layer refused')

		release_first()
		const stale = await first

		assert.equal(stale.ok, false, 'expected the older search outdated by the refused one')
		assert.equal(tool._roman_results, null, 'expected no stale list kept')
	})

	// Sergio, validación 2026-09-29: closing and reopening kept what was typed.
	// v6 rebuilds its modal on every click (special_tools_roman_empire.js:61-77)
	it('reopening the panel starts clean: fields, messages, list and filters', async function() {

		tool.get_capabilities = async function() {
			return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] } } }
		}
		tool.attach_roman_empire()
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
		tool._roman_results	= [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }]
		tool._roman_source	= 'dare'
		populate_roman_results(tool, panel)

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

	// Sergio, validación 2026-09-29: a click in the blank space right of a
	// layer name toggled it — the label stretched across its grid cell
	it('a Pelagios layer row is only as wide as its box and name', async function() {

		// with the tool CSS or not at all: without it a <label> is inline and
		// already this narrow, so the gate could never see justify-self go
		const link = document.createElement('link')
		link.rel	= 'stylesheet'
		link.href	= new URL('../../../tools/tool_uca_maps/css/tool_uca_maps.css', import.meta.url).href
		await new Promise((resolve, reject) => {
			link.addEventListener('load', resolve)
			link.addEventListener('error', reject)
			document.head.appendChild(link)
		})

		try {
			tool.get_capabilities = async function() {
				return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] } } }
			}
			tool.attach_roman_empire()
			await load_roman_capabilities(tool)

			geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

			const container = tool.roman_panel.querySelector('.uca-maps-roman-datasets')
			assert.equal(getComputedStyle(container).display, 'grid', 'expected the tool CSS applied — else this gate proves nothing')
			const rows = container.querySelectorAll('.uca-maps-roman-dataset-row')
			assert.equal(rows.length, 2, 'expected the two layers rendered — zero rows would pass the loop below')
			for (const row of rows) {
				const box	= row.querySelector('input').getBoundingClientRect().width
				const name	= row.querySelector('span').getBoundingClientRect().width
				assert.isAtMost(
					row.getBoundingClientRect().width, box + name + 12,
					'expected no clickable blank space beside the layer: ' + row.textContent
				)
			}
		} finally {
			link.remove()
		}
	})

	it('detach_roman_empire removes the button and panel', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
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
	})


	// review-diff 2026-09-29: the Pleiades geometry is fetched AFTER choosing,
	// so an error can arrive once the panel was closed and reopened clean
	it('a late error from drawing a Pleiades hit never lands in the panel reopened clean', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)

		const control	= geolocation.map.getContainer().querySelector('.uca-maps-roman-control')
		const panel		= tool.roman_panel
		const message	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-message')
		let release
		let asked = 0
		tool.tool_request = function() {
			asked++
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { place: null } }) })
		}
		const choose_roma = () => {
			tool._roman_results	= [{ name: 'Roma', id: '423025' }]
			tool._roman_source	= 'pleiades'
			populate_roman_results(tool, panel)
			tool.roman_dropdown.querySelector('.uca-maps-roman-result-button')
				.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))
		}
		control.click() // open

		// control half: with the panel left alone, the error IS shown
		choose_roma()
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(message.hidden, false, 'expected a geometry-less place reported under Pleiades')

		choose_roma()
		assert.equal(asked, 2, 'expected the second geometry request sent — else release() replays the first')
		control.click() // close
		control.click() // reopen: clean
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(message.hidden, true, 'expected the late error dropped by the reopened panel')
	})

	it('↑/↓ and Enter in one source\'s field never walk nor pick another source\'s list', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

		const panel				= tool.roman_panel
		const pleiades_input	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const asked = []
		tool.tool_request = async function(options) {
			asked.push(options.action)
			return { ok: true, data: { results: [] } }
		}
		tool._roman_results	= [{ name: 'Roma', id: '423025' }, { name: 'Roma Vecchia', id: '423026' }]
		tool._roman_source	= 'pleiades'
		populate_roman_results(tool, panel)

		// control: the list's OWN field walks it
		pleiades_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 0, 'expected ↓ in its own field to walk the list')

		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true}))
		assert.equal(tool._roman_active_index, 0, 'expected ↑/↓ in DARE not to walk the Pleiades list')

		dare_input.value = 'Gades'
		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await new Promise((resolve) => setTimeout(resolve, 50))
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
			tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
			tool.attach_roman_empire()
			assert.equal(added.length, 1, 'expected ONE capture mousedown listener on the map container')
			await tool.destroy(false, false, false)
			assert.include(removed, added[0], 'expected teardown to remove that same listener, in capture')
		} finally {
			delete container.addEventListener
			delete container.removeEventListener
		}
	})

	// review-diff 2026-09-30 (S2): closing voided the search in flight but not
	// the keystroke still waiting out the debounce, whose search then took a
	// NEWER token and reopened the list — after Esc, or over a closed panel
	it('closing the list cancels a keystroke still waiting out the debounce', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-roman-control')
		control.click() // open

		let asked = 0
		tool.tool_request = async function() {
			asked++
			return { ok: true, data: { results: [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }] } }
		}
		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const type_gades = () => {
			input.value = 'Gades'
			input.dispatchEvent(new Event('input'))
		}

		// control half: left alone, the keystroke DOES search and open the list
		type_gades()
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 1, 'expected the debounced search sent')
		assert.equal(tool.roman_dropdown.hidden, false)

		type_gades()
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 1, 'expected Esc to cancel the waiting search')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list to stay closed after Esc')

		type_gades()
		tool.roman_panel.querySelector('.uca-maps-panel-close').click() // the ×
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 1, 'expected the × to cancel the waiting search')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list over a closed panel')
	})

	it('Tab into another field closes the list, as a click there does', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

		const panel				= tool.roman_panel
		const pleiades_input	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		tool._roman_results	= [{ name: 'Roma', id: '423025' }]
		tool._roman_source	= 'pleiades'
		populate_roman_results(tool, panel)

		pleiades_input.focus() // its own field: the list stays
		assert.equal(tool.roman_dropdown.hidden, false, 'expected focus on the list\'s own field to keep it open')

		dare_input.focus()
		assert.equal(document.activeElement, dare_input, 'expected DARE focused — else no focusin happened')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected focus moving to another field to close the list')
	})

	it('opening the panel focuses the first ENABLED field', async function() {

		// only DARE needs no local data: with none, Pleiades and Pelagios are disabled
		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
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

	// review-diff 2026-09-30: the list is owned from the moment a field ARMS a
	// search, so going elsewhere cancels it waiting, in flight or open
	it('leaving the field cancels its search, whether waiting or in flight', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

		const panel				= tool.roman_panel
		const pleiades_input	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		let asked = 0
		let release = null
		tool.tool_request = function() {
			asked++
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } }) })
		}
		const type_roma = () => {
			pleiades_input.value = 'Roma'
			pleiades_input.dispatchEvent(new Event('input'))
		}

		// waiting out the debounce, then Tab into DARE
		type_roma()
		dare_input.focus()
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 0, 'expected Tab away to cancel the waiting search')

		// waiting, then a click in DARE
		type_roma()
		dare_input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 0, 'expected a click away to cancel the waiting search')

		// in flight, then Tab into DARE
		pleiades_input.focus()
		type_roma()
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 1, 'expected the search sent — else the next check proves nothing')
		dare_input.focus()
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no Pleiades list under a field the user left')
	})

	it('pressing the panel\'s scrollbar keeps the list; pressing a control closes it', function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel = tool.roman_panel
		tool._roman_results	= [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }]
		tool._roman_source	= 'dare'
		populate_roman_results(tool, panel)
		assert.equal(tool.roman_dropdown.hidden, false)

		// Chrome targets the scrolling element itself when its scrollbar is pressed
		panel.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the scrollbar press to leave the list to the scroll')

		panel.querySelector('.uca-maps-roman-dare-filters select').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a press on a filter to close it')
	})

	it('a late answer never opens the list under a field scrolled out of view', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel = tool.roman_panel
		panel.style.maxHeight	= '160px' // the suite has no tool CSS: make the panel scroll
		panel.style.overflowY	= 'auto'

		const input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		let release = null
		tool.tool_request = function() {
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } }) })
		}
		const search_roma = async () => {
			input.value = 'Roma'
			input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
			await new Promise((resolve) => setTimeout(resolve, 20))
		}

		// control half: the field in view, the answer opens the list
		await search_roma()
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open under a field in view')
		tool.close_roman_suggestions()

		await search_roma()
		panel.scrollTop = panel.scrollHeight // Pleiades, the first source, leaves the view
		assert.isBelow(input.getBoundingClientRect().top, panel.getBoundingClientRect().top + 1, 'expected the field scrolled out of view — else this gate proves nothing')
		// let that scroll's event pass FIRST: dispatched after the answer, it would
		// close the list on its own and this gate would never see the open-time check
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list under a field out of view')
	})

	it('a source that turns out unavailable takes its open list with it', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const seed_pleiades = () => {
			tool._roman_results	= [{ name: 'Roma', id: '423025' }]
			tool._roman_source	= 'pleiades'
			populate_roman_results(tool, tool.roman_panel)
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

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel = tool.roman_panel

		let release = null
		tool.tool_request = function(options) {
			if (options.action==='search_dare') {
				return Promise.resolve({ ok: true, data: { results: [] } })
			}
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { place: null } }) })
		}
		tool._roman_results	= [{ name: 'Roma', id: '423025' }]
		tool._roman_source	= 'pleiades'
		populate_roman_results(tool, panel)
		tool.roman_dropdown.querySelector('.uca-maps-roman-result-button')
			.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))
		assert.isFunction(release, 'expected the Pleiades geometry request in flight')

		await search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' })
		assert.equal(tool._roman_source, 'dare', 'expected DARE to own the list now')

		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-message').hidden, false, 'expected the error under Pleiades')
		assert.equal(panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-message').hidden, true, 'expected nothing under DARE')
	})

	// Sergio, validación 2026-09-30: with the list open, Tab should walk the
	// list, not close it and wander off through the panel
	it('with its list open, Tab walks from the field into the list and through it', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

		const panel	= tool.roman_panel
		const input	= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const key	= (target, name, shift) => {
			const event = new KeyboardEvent('keydown', {key: name, shiftKey: Boolean(shift), bubbles: true, cancelable: true})
			target.dispatchEvent(event)
			return event
		}
		const seed = () => {
			tool._roman_results	= [
				{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) },
				{ name: 'Gadir', geometry_type: 'Point', feature: roman_feature('Gadir', 36.6, -6.3) }
			]
			tool._roman_source	= 'dare'
			populate_roman_results(tool, panel)
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
		const feature_group	= geolocation.FeatureGroup[geolocation.active_layer_id]
		const before		= feature_group.getLayers().length
		key(input, 'Tab')
		const fresh_rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')
		key(fresh_rows[0], 'Enter')
		await new Promise((resolve) => setTimeout(resolve, 20))
		assert.equal(feature_group.getLayers().length, before + 1, 'expected Enter on the focused row to draw it')
		assert.equal(tool.roman_dropdown.hidden, true)
		assert.equal(document.activeElement, input, 'expected the focus back in the field, not lost on <body>')
	})

	it('walking the list by keyboard freezes it: no waiting or in-flight search rebuilds it', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel	= tool.roman_panel
		const input	= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const tab	= (target) => target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))

		let asked = 0
		let release = null
		tool.tool_request = function() {
			asked++
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { results: [
				{ name: 'NEW', geometry_type: 'Point', feature: roman_feature('NEW', 0, 0) }
			] } }) })
		}
		const seed = () => {
			tool._roman_results	= [{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) }]
			tool._roman_source	= 'dare'
			populate_roman_results(tool, panel)
			input.focus()
		}

		// a keystroke still waiting out the debounce, then Tab into the list
		seed()
		input.value = 'Gadesx'
		input.dispatchEvent(new Event('input'))
		tab(input)
		const row = document.activeElement
		assert.isTrue(row.classList.contains('uca-maps-roman-result-button'), 'expected the focus on a row')
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 0, 'expected the waiting search cancelled by entering the list')
		assert.equal(document.activeElement, row, 'expected the focus still on its row')

		// a search already in flight, then Tab into the list
		seed()
		input.value = 'Gadesy'
		input.dispatchEvent(new Event('input'))
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(asked, 1, 'expected the search in flight — else the next check proves nothing')
		tab(input)
		const held = document.activeElement
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.isTrue(document.contains(held), 'expected the focused row not rebuilt by the late answer')
		assert.equal(document.activeElement, held, 'expected the focus kept, not dropped to <body>')
		assert.notInclude(tool.roman_dropdown.textContent, 'NEW', 'expected the late hits discarded')
	})

	it('Tab past the last row enters a radio group at its CHECKED radio', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: { configured: true, pleiades: true, pelagios: [] } } } }
		tool.attach_roman_empire()
		await load_roman_capabilities(tool)
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel		= tool.roman_panel
		const input		= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const by_id		= panel.querySelector('.uca-maps-roman-pleiades-type input[value="id"]')
		by_id.checked = true

		tool._roman_results	= [{ name: 'Roma', id: '423025' }]
		tool._roman_source	= 'pleiades'
		populate_roman_results(tool, panel)
		input.focus()
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))
		document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))

		assert.equal(document.activeElement, by_id, 'expected the checked "by id" radio, as native Tab would')
		assert.isTrue(by_id.checked, 'expected the search type untouched')
	})

	it('while the keyboard is in the list, the pointer moves the focus with the highlight', async function() {

		tool.get_capabilities = async function() { return { ok: true, data: { gazetteers: null } } }
		tool.attach_roman_empire()
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()
		const panel	= tool.roman_panel
		const input	= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		tool._roman_results	= [
			{ name: 'Gades', geometry_type: 'Point', feature: roman_feature('Gades', 36.5, -6.2) },
			{ name: 'Gadir', geometry_type: 'Point', feature: roman_feature('Gadir', 36.6, -6.3) },
			{ name: 'Gadara', geometry_type: 'Point', feature: roman_feature('Gadara', 32.6, 35.7) }
		]
		tool._roman_source	= 'dare'
		populate_roman_results(tool, panel)
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
