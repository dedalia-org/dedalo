// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, L */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS_LAYERS
 * LIVE MAP (tool_uca_maps_fixture.js): XYZ basemaps, WMS services, Catastro and the
 * administrative units (UA).
 */

import { request_failed } from '../../../core/common/js/api_error.js'
import { check_administrative_unit_at_point } from '../../../tools/tool_uca_maps/js/administrative_units.js'
import { is_spanish_official_lang } from '../../../tools/tool_uca_maps/js/armed_layer.js'
import { check_catastro_at_point, is_catastro_enabled } from '../../../tools/tool_uca_maps/js/catastro.js'
import { default_symbol_icon } from '../../../tools/tool_uca_maps/js/legend.js'
import { search_places } from '../../../tools/tool_uca_maps/js/place_search.js'
import { show_ua_message } from '../../../tools/tool_uca_maps/js/render_administrative_units.js'
import { populate_place_search_results } from '../../../tools/tool_uca_maps/js/render_place_search.js'
import { populate_roman_results } from '../../../tools/tool_uca_maps/js/render_roman_empire.js'
import { populate_wms_search_results } from '../../../tools/tool_uca_maps/js/render_wms_services.js'
import {
	add_roman_result,
	search_roman
} from '../../../tools/tool_uca_maps/js/roman_empire.js'
import { create_toolbar_panel, remove_toolbar_panel } from '../../../tools/tool_uca_maps/js/toolbar.js'
import { DEFAULT_WMS_OPACITY } from '../../../tools/tool_uca_maps/js/wms_services.js'
import { DEFAULT_BASEMAPS, detach_xyz_basemaps } from '../../../tools/tool_uca_maps/js/xyz_basemaps.js'
import {
	roman_hit,
	toasts_during,
	until,
	use_live_map,
	WITH_PLEIADES,
	with_tool_css
} from './tool_uca_maps_fixture.js'



/**
* The credit's day, the viewer's local one, taken before and after `fn`: a run
* across midnight sees either, never a false red.
* @returns {string[]}
*/
const days_around = function(fn) {
	const day = () => new Date().toLocaleDateString('sv-SE')
	const before = day()
	fn()
	return [...new Set([before, day()])]
}

/** Asserts `text` holds `prefix` + one of `days`. */
const assert_credited_day = function(text, prefix, days, message) {
	assert.isTrue(days.some((d) => text.includes(prefix + d)), message + ' (' + JSON.stringify(text) + ')')
}

/** The last tile layer on the map, read off the map itself: the basemap until Catastro or UA lays its own over it. */
const find_active_tile_layer = function(map) {
	let found = null
	map.eachLayer((layer) => { if (layer instanceof L.TileLayer) found = layer })
	return found
}

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



describe('TOOL_UCA_MAPS (live map: layers)', function() {

	this.timeout(20000)

	let geolocation, tool, map_container
	const {
		CATASTRO_DEFAULT,
		offer_catastro,
		offer_defaults,
		geolocation_instance,
		real_tool_request,
		stub_tool_request,
		active_group,
		open_console_on,
		mount_roman,
		open_roman
	} = use_live_map((mounted) => ({geolocation, tool, map_container} = mounted))

	/** The layer Catastro or UA lays over the basemap when armed. */
	const is_armed_layer = (layer) => layer instanceof L.TileLayer
		&& /builtin=ign_admin_units|default_id=/.test(String(layer._url))

	/**
	* `entries` configured BEFORE the map is built, as on an install: the map is taken down
	* and get_map runs again on a context that already lists them (core's own overlays
	* come from get_map itself, not from a later rebuild).
	*/
	const mount_with_defaults = async function(entries) {
		const properties = geolocation.context.properties || {}
		geolocation.context = {...geolocation.context, properties: {...properties, map_sources: entries}}
		geolocation.map.remove()
		geolocation.map				= null
		geolocation.layer_control	= false
		await geolocation.get_map(map_container, 0)
		assert.isOk(geolocation.map, 'expected the map built again')
	}

	/** The layer-control entries whose tiles are `url_part`'s (the default or built-in it names). */
	const control_entries_of = (url_part) => Object.values(geolocation.layer_control._layers)
		.filter((entry) => String(entry.layer._url).includes(url_part))

	/**
	* Stands in for the component's save of a map source: the echo a server sends (an
	* id-less source numbered, or given the number of an equal one already stored), then
	* the component's own steps after a confirmed save. `fail` answers a refusal instead;
	* `hold`, a promise, keeps the answer on the wire until it settles. Returns the values
	* sent, in order.
	*/
	const fake_component_save = function({fail = false, hold = null, degraded = false} = {}) {
		const sent		= []
		let next_id		= 101
		geolocation.change_value = async function({changed_data}) {
			sent.push(JSON.parse(JSON.stringify(changed_data[0].value)))
			if (hold) {
				await hold
			}
			const value = JSON.parse(JSON.stringify(changed_data[0].value))
			if (fail) {
				return {ok: false, error: {is_api_error: true, code: 'request.invalid', message: 'Invalid data.'}}
			}
			// answered, but the component could not read its value back
			if (degraded) {
				geolocation.data_degraded = true
				return {ok: true, data: {}}
			}
			// the server's attribution rule (checkPlainText): control characters refused, trimmed
			if ((value.sources || []).some((source) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(source.attribution || ''))) {
				return {ok: false, error: {is_api_error: true, code: 'request.invalid', message: 'Invalid data.'}}
			}
			for (const source of value.sources || []) {
				source.attribution = (source.attribution || '').trim()
			}
			const stored	= geolocation.get_stored_entry(0)
			const held		= (stored && stored.sources) || []
			for (const source of value.sources || []) {
				if (held.some((kept) => kept.id===source.id)) {
					continue
				}
				const equal = held.find((kept) => kept.type===source.type && kept.url===source.url
					&& (kept.attribution || '')===(source.attribution || ''))
				source.id = equal ? equal.id : next_id++
			}
			geolocation.data.entries = [value]
			geolocation.learn_saved_map_definition(0)
			geolocation.build_source_layers(0)
			return {ok: true, data: {}}
		}
		return sent
	}

	const XYZ_URL = 'https://tiles.example.org/{z}/{x}/{y}.png'

	/** A WMS layer as the search hands it to add_wms_layer; `overrides` changes what a test is about. */
	const wms_layer = (overrides = {}) => ({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One', version: '1.3.0', crs: 'EPSG:3857', ...overrides})

	const arm_catastro = function() {
		geolocation.section_lang = 'lg-spa' // Catastro exists only for es/cat/eus
		offer_catastro()
		tool.attach_catastro()
		tool.catastro_control.getContainer().click()
	}



	// XYZ BASEMAPS (xyz_basemaps.js). The fixture has no geo_provider, so the
	// core takes its VARIOUS branch and builds a layer_control with arcgis and
	// osm: the "existing control" path this module must clean up (v6 listed
	// OSM twice).

	// accepted: core's own overlay checkbox for the entry beside the tool's basemap of the same source
	it('ARCGIS configured before the map is built: core\'s overlay checkbox stays beside the tool\'s ARCGIS basemap, both through the proxy', async function() {

		await mount_with_defaults([{id: 'arcgis', label: 'ArcGIS', type: 'xyz', attribution: 'Esri test credit'}])
		const core_entries = control_entries_of('default_id=arcgis')
		assert.lengthOf(core_entries, 1, 'expected core\'s own checkbox, built by get_map')
		assert.isTrue(core_entries[0].overlay, 'expected core\'s entry an overlay')

		tool.attach_xyz_basemaps()
		const entries = control_entries_of('default_id=arcgis')
		assert.lengthOf(entries, 2, 'expected core\'s checkbox kept and the tool\'s basemap added')
		assert.lengthOf(entries.filter((entry) => entry.overlay), 1, 'expected exactly one overlay: core\'s')
		const base = entries.find((entry) => !entry.overlay)
		assert.equal(base.name, 'ARCGIS', 'expected the tool\'s basemap')
		assert.equal(base.layer.getAttribution(), 'Esri test credit')
		for (const entry of Object.values(geolocation.layer_control._layers)) {
			assert.notInclude(String(entry.layer._url), 'arcgisonline', 'expected no direct Esri request on any entry')
		}
	})

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

		// OSM is the core's built-in: through the tile proxy, or OpenStreetMap's one direct
		// template where the server lists it in tile_direct; never a host the page names
		const osm_url = tile_entries.find((entry) => entry.name==='OSM').layer._url
		assert.isTrue(
			osm_url.includes('/api/v1/map_tile?') && osm_url.includes('builtin=osm')
				|| osm_url==='https://tile.openstreetmap.org/{z}/{x}/{y}.png',
			'expected the built-in osm, got ' + osm_url
		)
		assert.equal(
			osm_url.includes('/api/v1/map_tile?'),
			!(geolocation.context.features.tile_direct || []).includes('osm'),
			'expected the proxy exactly when the server does not list osm as direct'
		)

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

	it('add_basemap validates url/attribution/zoom, then saves the layer in the record and switches it on', async function() {

		tool.attach_xyz_basemaps()
		const sent = fake_component_save()

		const refusals = [
			[{url: '', attribution: 'x', minzoom: 0, maxzoom: 18}, 'The base map URL is required.'],
			[{url: 'not-a-url', attribution: 'x', minzoom: 0, maxzoom: 18}, 'Please enter a valid URL.'],
			[{url: 'https://{s}.tiles.example.org/{z}/{x}/{y}.png', attribution: 'x', minzoom: 0, maxzoom: 18}, 'The URL must contain {z}, {x} and {y}, and no other placeholder such as {s}.'],
			[{url: 'https://tiles.example.org/{z}/{x}.png', attribution: 'x', minzoom: 0, maxzoom: 18}, 'The URL must contain {z}, {x} and {y}, and no other placeholder such as {s}.'],
			[{url: XYZ_URL, attribution: '', minzoom: 0, maxzoom: 18}, 'The attribution is required: it names the layer on the map.'],
			[{url: XYZ_URL, attribution: 'x', minzoom: -1, maxzoom: 18}, 'Min zoom must be an integer between 0 and 22.'],
			[{url: XYZ_URL, attribution: 'x', minzoom: 0, maxzoom: 23}, 'Max zoom must be an integer between 0 and 22.'],
			[{url: XYZ_URL, attribution: 'x', minzoom: 18, maxzoom: 2}, 'Min zoom cannot be greater than max zoom.']
		]
		for (const [fields, error] of refusals) {
			assert.deepEqual(await tool.add_basemap(fields), {ok: false, error: error}, 'refused: ' + JSON.stringify(fields))
		}
		assert.equal(sent.length, 0, 'expected nothing saved by a refused add')

		const result = await tool.add_basemap({
			url: XYZ_URL, attribution: '<img src=x onerror=alert(1)>Example Org', minzoom: '2', maxzoom: '18'
		})
		assert.deepEqual(result, {ok: true})
		assert.equal(sent.length, 1, 'expected ONE save')
		assert.deepEqual(sent[0].sources, [
			{type: 'xyz', url: XYZ_URL, params: {min_zoom: 2, max_zoom: 18}, attribution: 'Example Org'}
		], 'expected an id-less xyz source of plain text, with integer zooms')
		assert.equal(sent[0].id, 9001, 'expected the whole entry sent: the save replaces it')
		assert.equal(sent[0].lib_data.length, 3, 'expected the drawn layers sent with it, not dropped')

		const layer = geolocation.source_layers['stored:101'].layer
		assert.equal(geolocation.map.hasLayer(layer), true, 'expected the saved layer drawn by the component and switched on')
		assert.include(layer._url, '/api/v1/map_tile?', 'expected its tiles through the proxy')
		assert.include(layer._url, 'source_id=101')
		assert.notInclude(layer._url, 'tiles.example.org', 'expected no provider address in the page')
		assert.equal(tool.basemaps.length, 2, 'expected the session base maps untouched')
		assert.equal(geolocation.is_data_changed, false, 'expected nothing left to save')

		// the same layer again is not saved twice (the server would number a copy): it is switched on
		layer.removeFrom(geolocation.map)
		assert.deepEqual(await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 2, maxzoom: 18}), {ok: true})
		assert.equal(sent.length, 1, 'expected no second save')
		assert.equal(geolocation.map.hasLayer(layer), true, 'expected the stored one switched on')

		// nor under another credit: the attribution names the tiles, it does not change them
		assert.deepEqual(await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org 2', minzoom: 2, maxzoom: 18}), {ok: true})
		assert.equal(sent.length, 1, 'expected no save for the same tiles under another attribution')

		// nor after a reload: the record's jsonb hands the params back in its own key order
		const stored = geolocation.data.entries[0].sources[0]
		stored.params = {max_zoom: stored.params.max_zoom, min_zoom: stored.params.min_zoom}
		assert.deepEqual(await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 2, maxzoom: 18}), {ok: true})
		assert.equal(sent.length, 1, 'expected no save for the same params in another key order')
	})

	it('a saved layer stays above the base maps, already stored when the tool opens or not', async function() {

		const assert_above_base = (layer, when) => {
			for (const base of tool._xyz_tile_layers) {
				assert.isAbove(layer.options.zIndex, base.options.zIndex, 'expected the saved layer above ' + base._url + ' ' + when)
			}
		}

		tool.attach_xyz_basemaps()
		fake_component_save()
		await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 0, maxzoom: 18})
		const layer = geolocation.source_layers['stored:101'].layer
		assert_above_base(layer, 'after adding it')

		assert.deepEqual(tool.move_basemap(0, 1), {ok: true})
		assert_above_base(layer, 'after a rebuild of the base maps')

		// a reload: the component offers the stored layer before the tool takes the base maps over
		detach_xyz_basemaps(tool)
		tool.attach_xyz_basemaps()
		assert_above_base(layer, 'after the take-over of a map that already offers it')
	})

	it('a refused save of a base map says so and leaves the layer out of the buffer', async function() {

		tool.attach_xyz_basemaps()
		fake_component_save({fail: true})

		const result = await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 0, maxzoom: 18})

		assert.deepEqual(result, {ok: false, error: 'The base map could not be saved.'})
		assert.isUndefined(geolocation.current_value[0].sources, 'expected the refused source taken back out of the buffer')
		assert.deepEqual(geolocation.source_layers, {}, 'expected no layer offered for it')
	})

	// every other save gate answers from a stand-in: this one sends what the tool builds to
	// the suite's own server, on the suite's own record, and puts that record back after
	it('core accepts the base map and the legend the tool saves: a real save, the record restored after', async function() {

		this.timeout(30000)
		// the record as the server holds it, not the seeded stand-in of beforeEach
		const reader = await geolocation_instance('uca_real_save_')
		await reader.build(true)
		assert.notEqual(reader.data_degraded, true, 'expected the record read whole, or it cannot be put back')
		const original = JSON.parse(JSON.stringify(reader.data?.entries || []))
		await reader.destroy(true)

		geolocation.data.entries	= JSON.parse(JSON.stringify(original))
		geolocation.current_value	= []
		let body_error = null
		try {
			tool.attach_xyz_basemaps()
			const added = await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 0, maxzoom: 18})
			assert.deepEqual(added, {ok: true}, 'expected core to accept the base map the tool sends')
			const source = (geolocation.get_stored_entry(0).sources || []).find((one) => one.url===XYZ_URL)
			assert.isOk(source, 'expected it stored')
			assert.isTrue(Number.isInteger(source.id), 'expected it numbered by the server')

			// the legend editor writes the buffer; the component's own save sends it
			tool.attach_legend()
			tool.set_legend_title('Roman roads')
			tool.add_legend_group()
			tool.set_legend_group_name(0, 'Surface')
			tool.add_legend_symbol(0)
			tool.set_legend_symbol_label(0, 0, 'Paved')
			const response = await geolocation.change_value({changed_data: [geolocation.build_changed_data_item(0)], refresh: false})
			assert.isOk(response, 'expected the save sent')
			assert.isFalse(request_failed(response), 'expected core to accept the legend the tool writes')
			assert.notEqual(geolocation.data_degraded, true)
			assert.deepEqual(geolocation.get_stored_entry(0).legend, {
				title: 'Roman roads', groups: [{name: 'Surface', symbols: [{label: 'Paved', icon: default_symbol_icon()}]}]
			}, 'expected the legend stored as the tool wrote it, its pin included')
		} catch (error) {
			body_error = error
		}

		// put back, then read back: a failed restore never hides the body's own failure
		const restore = original.length > 0
			? {action: 'set_data', key: null, id: null, value: original}
			: {action: 'clear', key: null, id: null, value: null}
		const restored = await geolocation.change_value({changed_data: [restore], refresh: false})
		const check = await geolocation_instance('uca_real_save_check_')
		await check.build(true)
		const after = JSON.parse(JSON.stringify(check.data?.entries || []))
		await check.destroy(true)
		if (body_error) {
			throw body_error
		}
		assert.isFalse(!restored || request_failed(restored), 'expected the suite record put back')
		assert.deepEqual(after, original, 'expected the suite record exactly as it was')
	})

	it('a save answered degraded is a refused one: the buffer gets the previous list back', async function() {

		tool.attach_xyz_basemaps()
		fake_component_save()
		await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 0, maxzoom: 18})
		const kept = JSON.parse(JSON.stringify(geolocation.current_value[0].sources))
		assert.lengthOf(kept, 1, 'expected one source saved first')

		fake_component_save({degraded: true})
		const result = await tool.add_basemap({url: 'https://other.example.org/{z}/{x}/{y}.png', attribution: 'Other', minzoom: 0, maxzoom: 18})
		assert.isFalse(result.ok, 'expected the degraded save refused')
		assert.deepEqual(geolocation.current_value[0].sources, kept, 'expected the previous list back in the buffer')
	})

	it('the take-over and every rebuild of the base maps leave the record\'s own layers alone', async function() {

		tool.attach_xyz_basemaps()
		fake_component_save()
		await tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 0, maxzoom: 18})
		const layer = geolocation.source_layers['stored:101'].layer

		assert.deepEqual(tool.move_basemap(0, 1), {ok: true})
		assert.deepEqual(tool.delete_basemap(0), {ok: true})

		assert.equal(geolocation.map.hasLayer(layer), true, 'expected the saved layer still on the map')
		const overlays = Object.values(geolocation.layer_control._layers).filter((entry) => entry.overlay)
		assert.include(overlays.map((entry) => entry.layer), layer, 'expected it still in the layer control')
	})

	it('an entity-typed attribution never becomes markup; an ordinary one shows as typed', async function() {

		tool.attach_xyz_basemaps()
		const sent			= fake_component_save()
		const container		= geolocation.map.getContainer()
		const overlay_names	= () => Array.from(
			container.querySelectorAll('.leaflet-control-layers-overlays label'),
			(label) => label.textContent.trim()
		)

		// strip_tags decodes the entities, and the server refuses `<` and `>`
		assert.deepEqual(await tool.add_basemap({url: XYZ_URL, attribution: '&lt;b&gt;x&lt;/b&gt;', minzoom: 0, maxzoom: 18}), {ok: true})
		assert.notMatch(sent[0].sources[0].attribution, /[<>]/, 'expected no angle bracket sent')
		assert.isNull(container.querySelector('.leaflet-control-layers b, .leaflet-control-attribution b'), 'expected no <b> element created')

		// an ordinary name is not double-escaped on the way
		const name = 'Diputació & Cartografía'
		assert.deepEqual(await tool.add_basemap({url: 'https://maps.example.org/{z}/{x}/{y}.png', attribution: name, minzoom: 0, maxzoom: 18}), {ok: true})
		assert.include(overlay_names(), name, 'expected the "&" and the accent shown as typed in the layer control')
		assert.include(container.querySelector('.leaflet-control-attribution').textContent, name, 'expected the attribution shown as typed')
		tool.xyz_control.getContainer().click() // opening the panel lists the saved layers
		const panel_names = Array.from(tool.xyz_panel.querySelectorAll('.uca-maps-xyz-saved-list .uca-maps-xyz-item-name'), (node) => node.textContent)
		assert.include(panel_names, name, 'expected the panel to list the saved layer as typed')
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

	it('the panel form validates, adds and saves, and deletes and saves, through the real DOM', async function() {

		tool.attach_xyz_basemaps()
		const sent		= fake_component_save()
		const panel		= tool.xyz_panel
		const add_btn	= panel.querySelector('.uca-maps-xyz-add-button')
		const message	= panel.querySelector('.uca-maps-xyz-message')
		const saved		= () => panel.querySelectorAll('.uca-maps-xyz-saved-list .uca-maps-xyz-item')

		assert.equal(add_btn.textContent, 'Add and save')
		assert.isNull(panel.querySelector('.uca-maps-xyz-name'), 'expected no name field: a saved layer is named by its attribution')

		add_btn.click() // every field empty -> the URL error
		await until(() => !message.hidden)
		assert.equal(message.textContent, 'The base map URL is required.')

		panel.querySelector('.uca-maps-xyz-url').value			= XYZ_URL
		panel.querySelector('.uca-maps-xyz-attribution').value	= 'DOM basemap'
		add_btn.click()
		await until(() => saved().length===1)

		assert.equal(message.hidden, true, 'expected the error message cleared on success')
		assert.equal(saved().length, 1, 'expected the saved layer listed')
		assert.equal(saved()[0].querySelector('.uca-maps-xyz-item-name').textContent, 'DOM basemap')
		assert.equal(panel.querySelectorAll('.uca-maps-xyz-list:not(.uca-maps-xyz-saved-list) .uca-maps-xyz-item').length, 2, 'expected the session base maps listed apart')

		saved()[0].querySelector('.uca-maps-xyz-delete').click()
		await until(() => saved().length===0)
		assert.equal(saved().length, 0, 'expected the row gone')
		assert.equal(sent.length, 2, 'expected the delete saved too')
		assert.isUndefined(sent[1].sources, 'expected the last source removed, the key with it')
		assert.deepEqual(geolocation.source_layers, {}, 'expected the component to offer it no more')
	})

	it('detach_xyz_basemaps removes the button/panel AND every tile layer it added from the live map', async function() {

		tool.attach_xyz_basemaps()
		const map_container_node = geolocation.map.getContainer()
		const tile_layers = tool._xyz_tile_layers
		assert.isOk(tool.xyz_control, 'expected the control attached first')

		// this fixture's default provider (VARIOUS) already had a
		// layer_control — attach_xyz_basemaps reused it (its
		// `_xyz_created_layer_control` stays false), so detach must leave the
		// control itself in place, only stripped of the tile layers THIS tool added
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



	// WMS (wms_services.js) — layers saved in the record as WMS sources, drawn
	// by the component through the tile proxy. GetCapabilities and the save are
	// always stubbed; the guarded fetch is test/unit/tool_uca_maps_get_wms_layers.test.ts's.

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
		offer_catastro()
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

		const failures	= []
		stub_tool_request(() => new Promise((resolve, reject) => { failures.push(reject) }))
		await toasts_during(async (toasts) => {
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
		})
	})

	it('search_wms_layers (mocked server) stores the parsed results; "Add and save" saves the layer in the record', async function() {

		// the guarded GetCapabilities fetch is the server's: awaited calls here,
		// not a DOM click racing its microtasks
		tool.attach_wms_services()
		const panel	= tool.wms_panel
		const sent	= fake_component_save()

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
			base_url	: 'https://example.com/geoserver/wms',
			version		: '1.3.0',
			layers		: [{name: 'topo:layer1', title: 'Layer One', crs: 'EPSG:3857'}]
		})

		populate_wms_search_results(tool, panel)
		const result_items = panel.querySelectorAll('.uca-maps-wms-result-item')
		assert.equal(result_items.length, 1)
		assert.equal(result_items[0].querySelector('.uca-maps-wms-result-title').textContent, 'Layer One')
		const add_btn = result_items[0].querySelector('.uca-maps-wms-result-add')
		assert.equal(add_btn.textContent, 'Add and save')

		add_btn.click()
		await until(() => panel.querySelectorAll('.uca-maps-wms-list .uca-maps-wms-item').length===1)

		assert.deepEqual(sent.map((value) => value.sources), [[{
			type		: 'wms',
			url			: 'https://example.com/geoserver/wms',
			params		: {version: '1.3.0', layers: 'topo:layer1', styles: '', format: 'image/png', transparent: false, crs: 'EPSG:3857'},
			attribution	: 'Layer One'
		}]], 'expected ONE save of the WMS source')
		const layer = geolocation.source_layers['stored:101'].layer
		assert.equal(geolocation.map.hasLayer(layer), true, 'expected the saved layer drawn by the component and switched on')
		assert.include(layer._url, 'source_id=101', 'expected its tiles through the proxy')
		assert.equal(layer.options.opacity, DEFAULT_WMS_OPACITY, 'expected v6\'s opacity on a new layer')
		assert.equal(panel.querySelector('.uca-maps-wms-list .uca-maps-wms-item-title').textContent, 'Layer One')

		tool.clear_wms_search()
		populate_wms_search_results(tool, panel)
		assert.equal(tool._wms_search_results, null, 'expected clear_wms_search to drop the stored results')
		assert.equal(panel.querySelectorAll('.uca-maps-wms-result-item').length, 0, 'expected the results list rebuilt empty')
	})

	it('a WMS layer the map cannot project, or a refused save, says so and saves nothing', async function() {

		tool.attach_wms_services()
		const sent = fake_component_save({fail: true})

		assert.deepEqual(
			await tool.add_wms_layer(wms_layer({crs: null})),
			{ok: false, error: 'This layer offers no projection the map can draw (EPSG:3857, EPSG:4326 or EPSG:4258).'}
		)
		assert.equal(sent.length, 0, 'expected nothing sent for a layer that cannot be drawn')

		assert.deepEqual(await tool.add_wms_layer(wms_layer()), {ok: false, error: 'The WMS layer could not be saved.'})
		assert.isUndefined(geolocation.current_value[0].sources, 'expected the refused source taken back out of the buffer')
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

	// a WMS <Title> is free text: the attribution is saved as the server keeps it
	it('a multi-line or padded WMS title is saved as one plain line, once', async function() {

		tool.attach_wms_services()
		const sent = fake_component_save()
		const layer = (title, name = 'topo:layer1') => wms_layer({name, title})

		assert.deepEqual(await tool.add_wms_layer(layer('Límites\n\tmunicipales\u2028 <IGN>')), {ok: true}, 'expected a multi-line title saved')
		assert.equal(sent[0].sources[0].attribution, 'Límites municipales IGN')

		assert.deepEqual(await tool.add_wms_layer(layer('  Límites municipales IGN  ')), {ok: true})
		assert.equal(sent.length, 1, 'expected the padded title found equal to the stored one: no second save')

		// the same layer under another title is still the same layer: no second save either
		assert.deepEqual(await tool.add_wms_layer(layer('Another title')), {ok: true})
		assert.equal(sent.length, 1, 'expected no save for the same layer under another title')

		// nor after a reload: the record's jsonb hands the params back in its own key order
		const stored = geolocation.data.entries[0].sources[0]
		stored.params = Object.fromEntries(Object.entries(stored.params).reverse())
		assert.deepEqual(await tool.add_wms_layer(layer('Límites municipales IGN')), {ok: true})
		assert.equal(sent.length, 1, 'expected no save for the same params in another key order')

		assert.deepEqual(await tool.add_wms_layer(layer('x'.repeat(400), 'topo:layer2')), {ok: true})
		assert.equal(sent[1].sources[1].attribution.length, 300, 'expected the attribution held to the core\'s 300 characters')
	})

	// the record can be closed while a save is on the wire: the late answer must not throw
	it('a save still in flight when the tool closes ends quietly: add and delete, WMS and XYZ', async function() {

		tool.attach_wms_services()
		tool.attach_xyz_basemaps()
		fake_component_save()
		await tool.add_wms_layer(wms_layer())

		let release
		fake_component_save({hold: new Promise((resolve) => { release = resolve })})
		const deleting	= tool.delete_wms_layer(101)
		const adding	= tool.add_wms_layer(wms_layer({name: 'topo:layer2', title: 'Layer Two'}))
		const basemap	= tool.add_basemap({url: XYZ_URL, attribution: 'Example Org', minzoom: 0, maxzoom: 18})

		await tool.destroy(false, false, false)
		assert.isNull(tool._source_opacity, 'expected the session state gone before the answers arrive')
		release()

		assert.deepEqual(await deleting, {ok: false}, 'expected a late delete to end quietly')
		assert.deepEqual(await adding, {ok: false}, 'expected a late add to end quietly')
		assert.isTrue((await basemap).ok, 'expected a late base map save to end without throwing')
	})

	it('toggle_wms_layer shows/hides the saved layer; set_wms_layer_opacity updates it, refuses out-of-range values and survives a rebuild', async function() {

		tool.attach_wms_services()
		fake_component_save()
		await tool.add_wms_layer(wms_layer())

		const layer = () => geolocation.source_layers['stored:101'].layer
		assert.equal(geolocation.map.hasLayer(layer()), true, 'expected visible right after add')

		assert.deepEqual(tool.toggle_wms_layer(101), {ok: true})
		assert.equal(tool.wms_sources()[0].visible, false)
		assert.equal(geolocation.map.hasLayer(layer()), false)

		assert.deepEqual(tool.toggle_wms_layer(101), {ok: true})
		assert.equal(tool.wms_sources()[0].visible, true)

		assert.deepEqual(tool.set_wms_layer_opacity(101, '0.4'), {ok: true})
		assert.equal(tool.wms_sources()[0].opacity, 0.4)
		assert.deepEqual(tool.set_wms_layer_opacity(101, '1.5'), {ok: false}, 'expected an out-of-range opacity refused')
		assert.equal(tool.wms_sources()[0].opacity, 0.4, 'expected the refused value NOT applied')
		assert.deepEqual(tool.toggle_wms_layer(999), {ok: false}, 'expected an unknown number refused')

		// another save rebuilds the component's layers: the session's opacity goes back on
		await tool.add_wms_layer(wms_layer({name: 'topo:layer2', title: 'Layer Two'}))
		assert.notEqual(layer(), null)
		assert.equal(layer().options.opacity, 0.4, 'expected the opacity re-applied to the rebuilt layer')
		assert.equal(geolocation.map.hasLayer(layer()), true, 'expected it kept on (the component remembers)')
	})

	// the component's own save button rebuilds the layers too, and the tool never sees it
	it('the component\'s save button keeps the session opacity, on the map and when switched on later', async function() {

		tool.attach_wms_services()
		fake_component_save()
		await tool.add_wms_layer(wms_layer())
		await tool.add_wms_layer(wms_layer({name: 'topo:layer2', title: 'Layer Two'}))
		assert.deepEqual(tool.set_wms_layer_opacity(101, '0.4'), {ok: true})
		assert.deepEqual(tool.set_wms_layer_opacity(102, '0.2'), {ok: true})
		assert.deepEqual(tool.toggle_wms_layer(102), {ok: true}, 'expected the second switched off before the save')

		const layer		= (id) => geolocation.source_layers['stored:' + id].layer
		const before	= layer(101)
		const save_node	= geolocation.node.querySelector('.button.save')
		assert.isOk(save_node, 'expected the component\'s save button')
		geolocation.is_data_changed = true // any edit marks it dirty; the button saves nothing otherwise
		save_node.click()
		await until(() => layer(101)!==before)

		assert.equal(geolocation.map.hasLayer(layer(101)), true, 'expected the rebuilt layer kept on')
		assert.equal(layer(101).options.opacity, 0.4, 'expected the session opacity on the rebuilt layer')
		assert.equal(geolocation.map.hasLayer(layer(102)), false)
		layer(102).addTo(geolocation.map) // what the component's layer control does
		assert.equal(layer(102).options.opacity, 0.2, 'expected the session opacity when switched on after the save')
	})

	it('delete_wms_layer takes the layer out of the record and saves; the survivor keeps its number', async function() {

		tool.attach_wms_services()
		const sent = fake_component_save()
		await tool.add_wms_layer(wms_layer())
		await tool.add_wms_layer(wms_layer({name: 'topo:layer2', title: 'Layer Two'}))
		const first = geolocation.source_layers['stored:101'].layer

		assert.deepEqual(await tool.delete_wms_layer(101), {ok: true})
		assert.equal(sent.length, 3, 'expected the delete saved')
		assert.deepEqual(tool.wms_sources().map((source) => [source.id, source.title]), [[102, 'Layer Two']])
		assert.equal(geolocation.map.hasLayer(first), false, 'expected the deleted layer off the map')
		assert.isUndefined(geolocation.source_layers['stored:101'], 'expected the component to offer it no more')
		assert.equal((await tool.delete_wms_layer(101)).ok, false, 'expected a number the record no longer holds refused, without a save')
		assert.equal(sent.length, 3)
	})

	// "centred" here is what toolbar.js does (the class, no anchoring); the
	// geometry is measured by the WMS layout test, with the tool CSS
	it('attach_wms_services builds its button and lists no layer on a record that saves none; its panel opens centred, its × closes it', function() {

		tool.attach_wms_services()
		const panel		= tool.wms_panel
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-wms-control')

		assert.isOk(control, 'expected the "WMS" toggle button')
		assert.equal(panel.hidden, true, 'expected the panel hidden by default')
		assert.deepEqual(tool.wms_sources(), [], 'expected no layer: the record stores none')
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

	it('the eye shows the layer\'s state and toggles it in place', async function() {

		tool.attach_wms_services()
		fake_component_save()
		await tool.add_wms_layer(wms_layer())
		geolocation.map.getContainer().querySelector('.uca-maps-wms-control').click()

		const panel			= tool.wms_panel
		const tile_layer	= geolocation.source_layers['stored:101'].layer
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
		// map's state, not from a default; the layer control switches the same layer
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
	it('the opacity slider shows the layer\'s opacity, when added and after a rebuild', async function() {

		tool.attach_wms_services()
		fake_component_save()
		await tool.add_wms_layer(wms_layer())
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-wms-control')
		const panel		= tool.wms_panel
		control.click()

		const slider = panel.querySelector('.uca-maps-wms-list .uca-maps-wms-opacity')
		assert.equal(slider.value, '0.7', 'expected the slider at the new layer\'s 0.7, not rounded to 1')

		tool.set_wms_layer_opacity(101, '0.3')
		control.click()
		control.click()
		assert.equal(
			panel.querySelector('.uca-maps-wms-list .uca-maps-wms-opacity').value,
			'0.3',
			'expected the rebuilt slider at the session\'s 0.3'
		)
	})

	// long names used to be squeezed by the slider; the panel sits where v6's
	// modal box did, centred and 5rem below the map top
	it('with the tool CSS, a WMS layer name keeps its width and the panel sits centred near the map top', async function() {

		await with_tool_css(async () => {
			tool.attach_wms_services()
			fake_component_save()
			for (let i = 1; i <= 3; i++) {
				await tool.add_wms_layer(wms_layer({
					name	: 'topo:layer' + i,
					title	: 'Límites administrativos históricos del municipio, capa ' + i
				}))
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

	it('detach_wms_services removes the button/panel and leaves the record\'s layers to the component', async function() {

		tool.attach_wms_services()
		fake_component_save()
		await tool.add_wms_layer(wms_layer())
		const map_container_node	= geolocation.map.getContainer()
		const layer					= geolocation.source_layers['stored:101'].layer

		await tool.destroy(false, false, false)

		assert.equal(tool.wms_control, null, 'expected wms_control cleared')
		assert.equal(tool.wms_panel, null, 'expected wms_panel cleared')
		assert.equal(tool._source_opacity, null, 'expected the session opacities cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-wms-control'),
			'expected the button removed from the DOM'
		)
		const overlays = Object.values(geolocation.layer_control._layers).filter((entry) => entry.overlay)
		assert.include(overlays.map((entry) => entry.layer), layer, 'expected the saved layer still offered by the component\'s layer control')
	})

	// CATASTRO (catastro.js) AND UA (administrative_units.js) — both exist only
	// for an es/cat/eus section_lang, which the fixture does not set, and both
	// lay a WMS layer over the basemap, which stays. Every lookup is stubbed.

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
		offer_catastro()
		assert.equal(is_spanish_official_lang(tool), true)

		tool.attach_catastro()
		tool.attach_catastro() // second call: must be a no-op, never a duplicate

		const controls = geolocation.map.getContainer().querySelectorAll('.uca-maps-catastro-control')
		assert.equal(controls.length, 1, 'expected exactly one "Catastro" button')
		assert.equal(is_catastro_enabled(tool), false, 'expected Catastro off by default')
	})

	it('without a `catastro` default in properties.map_sources there is no "Catastro" button, whatever the language', function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		assert.equal(tool.catastro_control, null, 'expected no "Catastro" button: the installation has not configured the source')

		offer_catastro()
		tool.attach_catastro()
		assert.isOk(tool.catastro_control, 'expected the button once the component lists the source')
	})

	it('armed, Catastro ticks core\'s own checkbox for the configured default, over the basemap, credited with its source and the day; disarmed, unticks it', function() {

		geolocation.section_lang = 'lg-spa'
		offer_catastro()
		tool.attach_catastro()

		const map			= geolocation.map
		const core_layer	= geolocation.source_layers['default:catastro'].layer
		const basemap		= find_active_tile_layer(map)
		assert.isOk(basemap, 'expected a basemap on the map before arming (test fixture default)')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected core\'s one checkbox to start with')

		const days = days_around(() => tool.catastro_control.getContainer().click())
		assert.equal(is_catastro_enabled(tool), true)
		assert.equal(tool._catastro_tile_layer, core_layer, 'expected core\'s own layer, not a second copy')
		assert.equal(map.hasLayer(core_layer), true, 'expected its checkbox ticked')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected still ONE Catastro entry in the layer control')
		assert.equal(map.hasLayer(basemap), true, 'expected the basemap kept under the parcels — an overlay, not a swap')
		assert.notInclude(String(core_layer._url), 'catastro.meh.es', 'expected no direct request to Catastro: the page CSP blocks it and the map image loses it')
		const credits = map.attributionControl.getContainer().textContent
		assert.include(credits, 'Test credit', 'expected the configured source credit on the armed map')
		assert_credited_day(credits, 'Catastro, ', days, 'expected the date the licence asks for, while armed')

		tool.catastro_control.getContainer().click()
		assert.equal(is_catastro_enabled(tool), false)
		assert.equal(map.hasLayer(core_layer), false, 'expected its checkbox unticked again')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected core\'s checkbox still offered')
		assert.notInclude(map.attributionControl.getContainer().textContent, 'Catastro, ', 'expected the date credit gone with it')
		assert.equal(map.hasLayer(basemap), true)
	})

	it('a `catastro` entry with no credit of its own is credited, while armed, with core\'s credit for the provider and the date', function() {

		geolocation.section_lang = 'lg-spa'
		offer_defaults([{...CATASTRO_DEFAULT, attribution: ''}])
		tool.attach_catastro()
		const days = days_around(() => tool.catastro_control.getContainer().click())

		assert_credited_day(
			geolocation.map.attributionControl.getContainer().textContent,
			'Dirección General del Catastro (Spain), ',
			days,
			'expected the source named even when the entry gives no credit'
		)
	})

	// UTC's day is the previous one in Spain after midnight: the suite runs in UTC, so a
	// clock whose local day (2000-01-01) and UTC day (1999-12-31) disagree stands in
	it('the credit\'s date is the viewer\'s local day, never UTC\'s', function() {

		geolocation.section_lang = 'lg-spa'
		offer_catastro()
		tool.attach_catastro()
		const RealDate = window.Date
		window.Date = class extends RealDate {
			getFullYear()		{ return 2000 }
			getMonth()			{ return 0 }
			getDate()			{ return 1 }
			getUTCFullYear()	{ return 1999 }
			getUTCMonth()		{ return 11 }
			getUTCDate()		{ return 31 }
			toISOString()		{ return '1999-12-31T23:30:00.000Z' }
		}
		try {
			tool.catastro_control.getContainer().click()
		} finally {
			window.Date = RealDate
		}
		const credits = geolocation.map.attributionControl.getContainer().textContent
		assert.notInclude(credits, '1999-12-31', 'expected no UTC day in the credit')
		assert.include(credits, 'Catastro, 2000-01-01', 'expected the local day in the credit')
	})

	it('Catastro configured before the map is built: core offers its checkbox from get_map, and arming ticks that one', async function() {

		geolocation.section_lang = 'lg-spa'
		await mount_with_defaults([CATASTRO_DEFAULT])
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected core\'s own checkbox, built by get_map')
		const core_layer = geolocation.source_layers['default:catastro'].layer

		tool.attach_catastro()
		tool.catastro_control.getContainer().click()
		assert.equal(tool._catastro_tile_layer, core_layer, 'expected core\'s layer, not a copy')
		assert.isTrue(geolocation.map.hasLayer(core_layer), 'expected its checkbox ticked')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected still one Catastro entry')

		tool.catastro_control.getContainer().click()
		assert.isFalse(geolocation.map.hasLayer(core_layer), 'expected it unticked again')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected core\'s checkbox still offered')
	})

	it('when core offers no layer for the entry, Catastro arms its own copy over the basemap, and disarming takes it out of the control', function() {

		geolocation.section_lang = 'lg-spa'
		offer_catastro()
		// core's overlay for the entry is gone (e.g. a core that stops offering it)
		const core_layer = geolocation.source_layers['default:catastro'].layer
		geolocation.layer_control.removeLayer(core_layer)
		delete geolocation.source_layers['default:catastro']
		assert.lengthOf(control_entries_of('default_id=catastro'), 0)

		const map		= geolocation.map
		const basemap	= find_active_tile_layer(map)
		tool.attach_catastro()
		tool.catastro_control.getContainer().click()
		const layer = tool._catastro_tile_layer
		assert.isOk(layer, 'expected a layer armed')
		assert.notEqual(layer, core_layer, 'expected the tool\'s own layer')
		assert.include(String(layer._url), 'default_id=catastro', 'expected the configured entry, through the tile proxy')
		assert.isTrue(map.hasLayer(layer), 'expected it on the map')
		assert.isTrue(map.hasLayer(basemap), 'expected the basemap kept under it')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected it offered in the layer control')
		assert.isTrue(control_entries_of('default_id=catastro')[0].overlay, 'expected an overlay, not a basemap')

		tool.catastro_control.getContainer().click()
		assert.isFalse(map.hasLayer(layer), 'expected it off the map')
		assert.lengthOf(control_entries_of('default_id=catastro'), 0, 'expected no stale entry left in the control')
	})

	for (const ticked of [true, false]) {
		it(`closing the tool with Catastro armed takes its credits away and leaves core's checkbox ${ticked ? 'ticked, as the viewer had it' : 'unticked'}`, async function() {

			const credit_line	= () => geolocation.node.querySelector('.uca-maps-catastro-credit')
			const map_credits	= () => geolocation.map.attributionControl.getContainer().textContent
			geolocation.section_lang = 'lg-spa'
			offer_catastro()
			const map			= geolocation.map
			const core_layer	= geolocation.source_layers['default:catastro'].layer
			if (ticked) {
				core_layer.addTo(map)
			}
			tool.attach_catastro()
			tool.catastro_control.getContainer().click()
			const handler = tool._catastro_click_handler
			stub_tool_request(async () => ({ok: true, data: {...parcel_found(), attribution: 'Dirección General del Catastro (Spain)'}}))
			await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
			assert.include(map_credits(), 'Catastro, ', 'expected the dated credit while armed')
			assert.isOk(credit_line(), 'expected the parcel\'s credit line')

			await tool.destroy(false, false, false)

			assert.notInclude(map_credits(), 'Catastro, ', 'expected the dated credit gone with the tool')
			assert.isNull(credit_line(), 'expected the parcel\'s credit line gone with the tool')
			assert.isFalse(map.listens('click', handler), 'expected the map click unhooked')
			assert.equal(map.hasLayer(core_layer), ticked, 'expected core\'s checkbox back as the viewer had it')
			assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected core\'s checkbox still offered')
		})
	}

	it('a Catastro checkbox the viewer had ticked stays ticked after Catastro is disarmed, also across a save rebuild', function() {

		geolocation.section_lang = 'lg-spa'
		offer_catastro()
		tool.attach_catastro()
		const map = geolocation.map
		geolocation.source_layers['default:catastro'].layer.addTo(map) // the viewer ticked it

		tool.catastro_control.getContainer().click()
		geolocation.build_source_layers(0) // a confirmed save rebuilds core's layers, keeping the ticked ones
		tool.catastro_control.getContainer().click()
		assert.equal(map.hasLayer(geolocation.source_layers['default:catastro'].layer), true, 'expected the viewer\'s own choice kept')

		// not ticked before arming: off after, even when a rebuild replaced the layer meanwhile
		map.removeLayer(geolocation.source_layers['default:catastro'].layer)
		tool.catastro_control.getContainer().click()
		geolocation.build_source_layers(0)
		tool.catastro_control.getContainer().click()
		assert.equal(map.hasLayer(geolocation.source_layers['default:catastro'].layer), false, 'expected the rebuilt layer unticked on disarm')
	})

	// one armed at a time, as v6's only_one_active_control: a click must ask one service
	it('Catastro and UA take turns: CAT → UA → CAT → UA, then closing UA, leaves only the original basemap', function() {

		geolocation.section_lang = 'lg-spa'
		offer_catastro()
		tool.attach_catastro()
		tool.attach_administrative_units()

		const map				= geolocation.map
		const original			= find_active_tile_layer(map)
		const wms_on_map		= () => {
			const layers = []
			map.eachLayer((layer) => { if (is_armed_layer(layer)) layers.push(layer) })
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
		assert.lengthOf(control_entries_of('builtin=ign_admin_units'), 0, 'expected the tool\'s own UA layer out of the layer control')
		assert.lengthOf(control_entries_of('default_id=catastro'), 1, 'expected core\'s Catastro checkbox still offered, once')
		assert.equal(tool._armed_layer, null, 'expected nothing left armed')
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

	// Catastro may name a parcel without linking its record (a non-https link is dropped)
	it('a parcel found with no url is drawn with no url property, and the console offers no link', async function() {

		tool.attach_console()
		arm_catastro()
		stub_tool_request(async () => ({ok: true, data: parcel_found(null)}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		const layers	= active_group().getLayers()
		const parcel	= layers[layers.length - 1]
		assert.notProperty(parcel.feature.properties, 'url', 'expected no url key, not url: null')
		assert.isTrue(parcel.feature.properties.uca_maps.catastro, 'expected the parcel still marked as Catastro\'s')
		parcel.openPopup()
		assert.isNotOk(tool.console_panel.querySelector('.uca-maps-property-link'), 'expected no link')
		const keys = Array.from(tool.console_panel.querySelectorAll('.uca-maps-properties-list .uca-maps-property-key'), (key) => key.textContent)
		assert.notInclude(keys, 'url:', 'expected no url row')
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

		const find_url_row = () => Array.from(tool.console_panel.querySelectorAll('.uca-maps-properties-list .uca-maps-property-item'))
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
		assert.isNotOk(tool.console_panel.querySelector('.uca-maps-property-link'), 'expected a javascript: url kept out of any href')
		const fallback = find_url_row() && find_url_row().querySelector('input.uca-maps-property-value')
		assert.isOk(fallback, 'expected the row still there, falling back to editable text')
		assert.equal(fallback.value, 'javascript:alert(1)')

		// the same key on an ordinary polygon is plain editable text
		parcel.feature.properties.url = 'https://example.com/parcel'
		delete parcel.feature.properties.uca_maps.catastro
		parcel.closePopup()
		parcel.openPopup()
		assert.isNotOk(tool.console_panel.querySelector('.uca-maps-property-link'), 'expected no link without the catastro mark')
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

	// core's page notice says why a lookup failed: the banner keeps no line
	// about it, and an earlier "not found" goes with it
	it('a failed Catastro lookup leaves no banner line; "not found" then shows one warning', async function() {

		arm_catastro()
		const banner = () => geolocation.node.querySelector('.uca-maps-catastro-message')

		stub_tool_request(async () => ({ok: true, data: {found: false}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isOk(banner(), 'expected the not-found banner first')

		stub_tool_request(async () => ({ok: false, error: {is_api_error: true, code: 'client.timeout', message: 'The request timed out', transport: true}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isNull(banner(), 'expected no banner beside core\'s notice')

		stub_tool_request(async () => ({ok: true, data: {found: false}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		const lines = Array.from(banner().querySelectorAll('.text'), (node) => node.textContent)
		assert.deepEqual(lines, ['No parcel could be found at this point.'], 'expected one line')
		assert.isTrue(banner().classList.contains('warning') && !banner().classList.contains('error'), 'expected the banner a warning only')
	})

	it('a two-line panel message keeps its line break', async function() {

		// with the tool CSS or not at all: without it white-space is never pre-line
		await with_tool_css(async () => {
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

	// core's banner times out (10 s); the credit belongs beside the parcel while
	// it is the answer, so it is the tool's own line, gone with the next lookup,
	// a disarm or the tool
	it('a found parcel keeps the provider\'s credit in the tool\'s own line until the next lookup or a disarm', async function() {

		const credit = () => geolocation.node.querySelector('.uca-maps-catastro-credit')
		const found = {...parcel_found(), attribution: 'Dirección General del Catastro (Spain)'}

		arm_catastro()
		stub_tool_request(async () => ({ok: true, data: found}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isOk(credit(), 'expected the credit line')
		assert.isTrue(credit().classList.contains('uca-maps-attribution'), 'expected the quiet credit style')
		assert.equal(credit().textContent, 'Dirección General del Catastro (Spain)')
		assert.isNull(credit().closest('.uca-maps-catastro-message'), 'expected it outside core\'s timed banner')
		assert.isNull(geolocation.node.querySelector('.uca-maps-catastro-message'), 'expected no banner beside the parcel')

		// the next lookup takes it away as soon as it starts
		let release
		stub_tool_request(() => new Promise((resolve) => { release = resolve }))
		const pending = check_catastro_at_point(tool, L.latLng(40.16, -3.66))
		assert.isNull(credit(), 'expected the credit gone while the next lookup runs')
		release({ok: true, data: found})
		await pending
		assert.equal(geolocation.node.querySelectorAll('.uca-maps-catastro-credit').length, 1, 'expected one credit, never two')

		tool.catastro_control.getContainer().click() // disarm
		assert.isNull(credit(), 'expected no credit once Catastro is disarmed')

		arm_catastro()
		stub_tool_request(async () => ({ok: true, data: found}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isOk(credit())
		await tool.destroy(false, false, false)
		assert.isNull(credit(), 'expected no credit once the tool is closed')
	})

	// the providers' licences (ODbL, CC BY) ask for their credit beside their
	// data: core's geo services answer it, the tool shows it, quietly
	it('place search and DARE list the provider\'s credit after their hits, never as a hit', async function() {

		tool.attach_place_search()
		stub_tool_request(async () => ({ok: true, data: {
			results		: [{name: 'Sagunt', point: [39.68, -0.27], bbox: null}],
			attribution	: '© OpenStreetMap contributors (ODbL)'
		}}))
		await search_places(tool, 'Sagunto')
		populate_place_search_results(tool, tool.place_search_panel)
		const list = tool.place_search_panel.querySelector('.uca-maps-place-search-results')
		assert.equal(list.querySelectorAll('.uca-maps-place-search-result-button').length, 1)
		assert.equal(list.lastElementChild.className, 'uca-maps-attribution', 'expected the credit last')
		assert.equal(list.lastElementChild.textContent, '© OpenStreetMap contributors (ODbL)')

		stub_tool_request(async () => ({ok: true, data: {results: [], attribution: '© OpenStreetMap contributors (ODbL)'}}))
		await search_places(tool, 'Nowhere')
		populate_place_search_results(tool, tool.place_search_panel)
		assert.isNull(list.querySelector('.uca-maps-attribution'), 'expected no credit for no data')

		mount_roman()
		open_roman()
		stub_tool_request(async () => ({ok: true, data: {results: [roman_hit('Gades', 36.5, -6.2)], attribution: 'DARE, CC BY'}}))
		await search_roman(tool, 'dare', {query: 'Gades', name_type: 'mss'})
		populate_roman_results(tool, tool.roman_panel)
		assert.equal(tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button').length, 1, 'expected the credit not a row')
		assert.equal(tool.roman_dropdown.querySelector('.uca-maps-attribution').textContent, 'DARE, CC BY')

		stub_tool_request(async () => ({ok: true, data: {results: [], attribution: 'DARE, CC BY'}}))
		await search_roman(tool, 'dare', {query: 'Nowhere', name_type: 'mss'})
		populate_roman_results(tool, tool.roman_panel)
		assert.isNull(tool.roman_dropdown.querySelector('.uca-maps-attribution'), 'expected no DARE credit for no data')
	})

	it('the elevation line carries its provider\'s credit under the heading', async function() {

		tool._elevation = null
		stub_tool_request(async () => ({ok: true, data: {elevation: 412, unavailable: false, attribution: 'NASA/USGS SRTM'}}))
		open_console_on(1)
		const section = tool.console_panel.querySelector('.uca-maps-elevation-section')
		await until(() => section.querySelector('.uca-maps-attribution'), 100)
		const credit = section.querySelector('.uca-maps-attribution')
		assert.isOk(credit, 'expected the credit')
		assert.equal(credit.textContent, 'NASA/USGS SRTM')
		assert.equal(credit.previousElementSibling, section.querySelector('.uca-maps-object-elevation'), 'expected it right under the heading')
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

	it('detach_catastro removes the button AND keeps the basemap on the live map', async function() {

		geolocation.section_lang = 'lg-spa'
		offer_catastro()
		tool.attach_catastro()

		const previous_base_layer = find_active_tile_layer(geolocation.map)
		tool.catastro_control.getContainer().click() // arm
		const tile_layer = tool._catastro_tile_layer
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.catastro_control, null, 'expected catastro_control cleared')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-catastro-control'), 'expected the button removed from the DOM')
		assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected the cadastral layer removed from the map')
		assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the basemap still on the map after teardown, not left blank')
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

		it('attach_administrative_units builds the button+panel (no level select) once section_lang is es/cat/eus', function() {

			geolocation.section_lang = 'lg-eus'
			tool.attach_administrative_units()
			tool.attach_administrative_units() // second call: must be a no-op

			const controls = geolocation.map.getContainer().querySelectorAll('.uca-maps-ua-control')
			assert.equal(controls.length, 1, 'expected exactly one "UA" button')
			assert.isOk(tool.ua_panel, 'expected the UA panel built')
			assert.equal(tool.ua_panel.hidden, true, 'expected the panel hidden by default')
			// core's service answers one unit of no chosen level: a select would promise a choice
			assert.isNotOk(tool.ua_panel.querySelector('select'), 'expected no level select')
			assert.isOk(tool.ua_panel.querySelector('.uca-maps-ua-message'), 'expected the message line rendered')
		})

		// v6's UA_on swapped the basemap; core's built-in is boundaries only, transparent,
		// so alone it showed nothing at a record's zoom: the units go OVER the basemap
		it('opening the "UA" panel lays the units over the active basemap, as a checkbox; closing it takes them off', function() {

			geolocation.section_lang = 'lg-spa'
			tool.attach_administrative_units()

			const previous_base_layer = find_active_tile_layer(geolocation.map)
			assert.isOk(previous_base_layer, 'expected a basemap already on the map before arming (test fixture default)')
			const active_before = geolocation.active_layer_id

			tool.ua_control.getContainer().click()
			assert.equal(tool.ua_panel.hidden, false, 'expected the panel open')
			assert.isOk(tool._ua_tile_layer, 'expected the administrative-units tile layer built')
			assert.equal(geolocation.map.hasLayer(tool._ua_tile_layer), true, 'expected it active on the map')
			const ua_url = tool._ua_tile_layer._url
			assert.include(ua_url, '/api/v1/map_tile?', 'expected the core\'s built-in, through the tile proxy')
			assert.include(ua_url, 'builtin=ign_admin_units')
			assert.notInclude(ua_url, 'ign.es', 'expected no provider address in the page')
			assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the basemap kept under the units — an overlay, not a swap')
			const ua_entry = Object.values(geolocation.layer_control._layers).find((entry) => entry.layer===tool._ua_tile_layer)
			assert.isOk(ua_entry, 'expected the units listed in the layer control')
			assert.equal(ua_entry.overlay, true, 'expected them a checkbox, not a basemap radio')
			assert.equal(tool._ua_tile_layer.options.dedalo_source, true, 'expected a tile layer core never makes the active drawing layer')
			assert.equal(geolocation.active_layer_id, active_before, 'expected the active drawing layer unchanged')
			assert.isAbove(tool._ua_tile_layer.options.zIndex, previous_base_layer.options.zIndex || 1, 'expected the units above the basemap')
			const ua_layer = tool._ua_tile_layer

			tool.ua_control.getContainer().click()
			assert.equal(tool.ua_panel.hidden, true, 'expected the panel closed')
			assert.equal(tool._ua_tile_layer, null, 'expected the tile layer cleared')
			assert.equal(geolocation.map.hasLayer(ua_layer), false, 'expected the units off the map')
			assert.isFalse(Object.values(geolocation.layer_control._layers).some((entry) => entry.layer===ua_layer), 'expected the units out of the layer control')
			assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the basemap still there')
		})

		it('with an `ign_unidades` default in properties.map_sources, UA ticks core\'s own checkbox for it instead of adding the built-in', function() {

			geolocation.section_lang = 'lg-spa'
			offer_defaults([{id: 'ign_unidades', label: 'Unidades', type: 'wms', attribution: 'IGN test credit', crs: 'EPSG:3857'}])
			tool.attach_administrative_units()
			const core_layer = geolocation.source_layers['default:ign_unidades'].layer
			const basemap = find_active_tile_layer(geolocation.map)

			tool.ua_control.getContainer().click()
			assert.equal(tool._ua_tile_layer, core_layer, 'expected core\'s own layer, not a second copy')
			assert.equal(geolocation.map.hasLayer(core_layer), true, 'expected its checkbox ticked')
			assert.lengthOf(control_entries_of('default_id=ign_unidades'), 1, 'expected ONE units entry in the layer control')
			assert.lengthOf(control_entries_of('builtin=ign_admin_units'), 0, 'expected no built-in beside it')
			assert.equal(geolocation.map.hasLayer(basemap), true, 'expected the basemap kept under the units')

			tool.ua_control.getContainer().click()
			assert.equal(geolocation.map.hasLayer(core_layer), false, 'expected its checkbox unticked again')
			assert.lengthOf(control_entries_of('default_id=ign_unidades'), 1, 'expected core\'s checkbox still offered')
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

		it('check_administrative_unit_at_point asks with the clicked point only, no level', async function() {

			arm_ua()

			let requested_options = null
			stub_tool_request(async function(options) {
				requested_options = options
				return {ok: true, data: {found: false}}
			})
			await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

			assert.equal(requested_options.action, 'get_administrative_unit')
			assert.notProperty(requested_options.options, 'level', 'expected no level: core\'s service cannot honour one')
			assert.includeMembers(Object.keys(requested_options.options), ['bbox', 'width', 'height', 'x', 'y'])
		})

		it('check_administrative_unit_at_point (found) names the unit and its level in the panel, creates nothing', async function() {

			arm_ua()

			stub_tool_request(async () => ({ok: true, data: {found: true, unit: {name: 'Test municipality', level: 'Municipio', code: '1'}}}))

			const before_layer_count = active_group().getLayers().length
			await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

			const message = tool.ua_panel.querySelector('.uca-maps-ua-message')
			const level = tool.get_tool_label('ua_level_municipio') || 'Municipio'
			assert.equal(message.hidden, false, 'expected the unit shown in the panel')
			assert.equal(message.dataset.type, 'ok')
			assert.equal(message.textContent, 'Test municipality (' + level + ')')
			assert.equal(active_group().getLayers().length, before_layer_count, 'expected no object: the service has no geometry')

			// a level the server could not name: the bare name, never "(null)"
			stub_tool_request(async () => ({ok: true, data: {found: true, unit: {name: 'España', level: null, code: null}}}))
			await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
			assert.equal(message.textContent, 'España')
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

			const pending = check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

			tool.ua_control.getContainer().click() // close WHILE the request is in flight
			assert.equal(tool.ua_panel.hidden, true, 'expected the panel closed')

			resolve_tool_request({ok: true, data: {found: true, unit: {name: 'Late unit', level: 'Provincia', code: null}}})
			await pending

			const message = tool.ua_panel.querySelector('.uca-maps-ua-message')
			assert.equal(message.hidden, true, 'expected the late "found" response NOT written into the closed panel')
		})

		it('detach_administrative_units removes the button/panel AND keeps the basemap on the live map', async function() {

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
			assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected the administrative-units layer removed from the map')
			assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the basemap still on the map after teardown, not left blank')
		})
	})

	// armed_layer.js, shared by Catastro and UA: a map click is the lookup, and disarming
	// undoes all of it. Catastro arms core's own checkbox (`core`); UA without a configured
	// source adds the built-in, and the layer control it had to create for it
	for (const armed of [
		{key: 'catastro', attach: 'attach_catastro', control: 'catastro_control', action: 'get_catastro_parcel', core: true},
		{key: 'ua', attach: 'attach_administrative_units', control: 'ua_control', action: 'get_administrative_unit', core: false}
	]) {
		it(`${armed.key}: a map click asks with the view and clicked pixel; disarming unhooks the click and the layer`, async function() {

			const map		= geolocation.map
			const toggle	= () => tool[armed.control].getContainer().click()
			const handler	= () => tool[`_${armed.key}_click_handler`]

			geolocation.section_lang = 'lg-spa'
			offer_catastro()
			tool[armed.attach]()

			let requested = null
			stub_tool_request(async (options) => {
				requested = options
				return {ok: true, data: {found: false}}
			})

			// with the fixture's own layer control
			const fixture_control = geolocation.layer_control
			toggle() // arm
			const armed_handler	= handler()
			const tile_layer	= tool[`_${armed.key}_tile_layer`]
			assert.isTrue(map.listens('click', armed_handler), 'expected the map click armed')

			// a pixel off the diagonal, so x and y cannot stand for each other
			const latlng = map.containerPointToLatLng(L.point(37, 101))
			map.fire('click', {latlng})
			assert.isOk(requested, 'expected the click to reach tool_request')
			await until(() => !tool[`_${armed.key}_busy`])
			assert.isFalse(tool[`_${armed.key}_busy`], 'expected the lookup settled')

			const bounds	= map.getBounds()
			const size		= map.getSize()
			const point		= map.latLngToContainerPoint(latlng)
			assert.equal(requested.action, armed.action)
			assert.deepEqual(requested.options, {
				tipo			: geolocation.tipo,
				section_id		: geolocation.section_id,
				section_tipo	: geolocation.section_tipo,
				bbox			: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
				width			: size.x,
				height			: size.y,
				x				: point.x,
				y				: point.y
			})

			toggle() // disarm
			assert.isFalse(map.listens('click', armed_handler), 'expected the map click unhooked')
			assert.strictEqual(geolocation.layer_control, fixture_control, 'expected the fixture\'s control kept')
			assert.isFalse(map.hasLayer(tile_layer), 'expected the layer off the map')
			assert.equal(
				Object.values(fixture_control._layers).some((entry) => entry.layer===tile_layer),
				armed.core,
				armed.core ? 'expected core\'s checkbox still offered' : 'expected the tool\'s layer out of the layer control'
			)
		})
	}

	// UA's built-in is the tool's own layer: it joins whatever control the map has, or
	// one it creates, and only the one it created leaves with it
	it('ua: arming reuses the map\'s layer control; with none (core\'s OSM branch), creates one and removes it on disarm', function() {

		const map		= geolocation.map
		const toggle	= () => tool.ua_control.getContainer().click()
		geolocation.section_lang = 'lg-spa'
		tool.attach_administrative_units()

		const fixture_control = geolocation.layer_control
		toggle() // arm
		assert.isNotOk(tool._ua_created_layer_control, 'expected the existing control reused, not a new one')
		assert.strictEqual(geolocation.layer_control, fixture_control)
		toggle() // disarm
		assert.strictEqual(geolocation.layer_control, fixture_control, 'expected the fixture\'s control kept')

		// the fixture's control is removed for real, as in the XYZ takeover
		map.removeControl(fixture_control)
		geolocation.layer_control = false
		const original_base_layer = find_active_tile_layer(map)
		assert.isOk(original_base_layer, 'expected the fixture basemap on the map')

		toggle() // arm
		const created_control = geolocation.layer_control
		assert.isOk(created_control, 'expected a layer control created')
		assert.isTrue(tool._ua_created_layer_control, 'expected the creation recorded')
		assert.isTrue(map.getContainer().contains(created_control.getContainer()), 'expected the created control on the map')

		toggle() // disarm
		assert.isFalse(map.getContainer().contains(created_control.getContainer()), 'expected the created control gone from the map')
		assert.strictEqual(geolocation.layer_control, false, 'expected no control left behind')
		assert.isTrue(map.hasLayer(original_base_layer), 'expected the original basemap back')
	})

	// core's page notice says why, once and translated (details.reason_key):
	// no panel repeats it, and UA's line of an earlier lookup goes
	it('a refusal leaves no panel line: UA, WMS, place and Roman searches', async function() {

		arm_ua()
		tool.attach_wms_services()
		tool.attach_place_search()
		mount_roman(WITH_PLEIADES)

		stub_tool_request(async () => ({ok: false, error: {
			is_api_error	: true,
			code			: 'request.invalid_options',
			label_key		: 'error_request_invalid_options',
			details			: {reason_key: 'search_text_too_long'},
			message			: 'The search text is too long.',
			transport		: false
		}}))

		const ua_line = tool.ua_panel.querySelector('.uca-maps-ua-message')
		show_ua_message(tool.ua_panel, 'an earlier line')
		assert.isFalse(ua_line.hidden, 'expected the earlier line shown first')
		await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
		assert.isTrue(ua_line.hidden, 'expected the UA line taken away')

		tool._roman_results = [{id: '265849'}]
		const rows = [
			{label: 'wms search', run: () => tool.search_wms_layers('https://example.com/geoserver/wms')},
			{label: 'place search', run: () => search_places(tool, 'Sagunto')},
			{label: 'roman search', run: () => search_roman(tool, 'pleiades', {query: 'Saguntum', type: 'name'})},
			{label: 'roman add', run: () => add_roman_result(tool, 0)}
		]
		for (const row of rows) {
			assert.deepEqual(await row.run(), {ok: false}, row.label)
		}
	})

	// kept last in its file: client_suite_census.ts (test/helpers/) reads the quote in this
	// test's regex literal as an open string, and would count no it() after it
	it('ARCGIS loads straight from Esri unless the component configures an `arcgis` default, then it comes through the tile proxy', function() {

		const arcgis_layer = () => Object.values(geolocation.layer_control._layers)
			.find((entry) => entry.name==='ARCGIS').layer

		tool.attach_xyz_basemaps()
		assert.include(String(arcgis_layer()._url), 'server.arcgisonline.com', 'expected the direct Esri tiles without a configured default')
		detach_xyz_basemaps(tool)

		offer_defaults([{id: 'arcgis', label: 'ArcGIS', type: 'xyz', attribution: 'Esri test credit'}])
		tool.attach_xyz_basemaps()
		const layer = arcgis_layer()
		assert.include(String(layer._url), 'default_id=arcgis', 'expected the configured default, through the tile proxy, so the map image includes it')
		assert.notInclude(String(layer._url), 'arcgisonline', 'expected no direct Esri request')
		assert.notEqual(layer.options.dedalo_source, true, 'expected a base layer, which the takeover and rebuilds manage, not a record overlay')
		assert.equal(layer.getAttribution(), 'Esri test credit', 'expected the configured credit')
		assert.equal(layer.options.maxNativeZoom, 19, 'expected tiles asked no further than Esri\'s z19 when the entry names no last zoom')
		detach_xyz_basemaps(tool)

		offer_defaults([{id: 'arcgis', label: 'ArcGIS', type: 'xyz', attribution: 'Esri test credit', max_zoom: 17}])
		tool.attach_xyz_basemaps()
		assert.equal(arcgis_layer().options.maxNativeZoom, 17, 'expected the entry\'s own last zoom kept')
		detach_xyz_basemaps(tool)

		offer_defaults([{id: 'arcgis', label: 'ArcGIS', type: 'xyz', attribution: ''}])
		tool.attach_xyz_basemaps()
		// whole and as text: get_source_layer escapes it, so an entity in it would show literally
		const esri = DEFAULT_BASEMAPS.find((basemap) => basemap.default_id==='arcgis').attribution
		assert.equal(arcgis_layer().getAttribution(), esri, 'expected Esri\'s own credit, whole, when the entry gives none')
		assert.notMatch(esri, /[&<>"']/, 'expected a credit escaping leaves unchanged')
	})
})


// @license-end
