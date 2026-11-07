// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals, L, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/

import { elements } from './elements.js'
import {get_instance} from '../../../core/common/js/instances.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {is_empty, component_common} from '../../../core/component_common/js/component_common.js'
import {ui} from '../../../core/common/js/ui.js'



// element options for component_geolocation
	const element = elements.find(el => el.model==='component_geolocation')
	if (!element) {
		console.error('Error: component_geolocation not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo  // test100
	const lang			= element.lang



// DOM containers
	const container = document.getElementById('content');

	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



// mode/view matrix for component_geolocation
// edit: default, line, print
// list: default, mini, text
// search: default
	const mode_view_pairs = [
		{ mode: 'edit',	view: 'default'	},
		{ mode: 'edit',	view: 'line'	},
		{ mode: 'edit',	view: 'print'	},
		{ mode: 'list',	view: 'default'	},
		{ mode: 'list',	view: 'mini'	},
		{ mode: 'list',	view: 'text'	},
		{ mode: 'search',view: 'default'	}
	]



// HELPERS (shared by the empty-record suites)

	/**
	* BUILD_EMPTY_INSTANCE
	* Builds an edit instance and forces the engine's empty shape (WC-001 `entries: []`)
	* so the suites below assert the "record has no stored geolocation" contract on a
	* real element (test100) without depending on a second, unstored fixture record.
	* @param {string} id_variant
	* @returns {Promise<Object>} built (not rendered) instance with data.entries = []
	*/
	const build_empty_instance = async function(id_variant) {

		const instance = await get_instance({
			model			: 'component_geolocation',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: id_variant + '_' + Math.random()
		})
		await instance.build(true)

		// the engine's empty shape: a record with no stored geolocation
		instance.data.entries	= []
		instance.permissions	= 2

		return instance
	}//end build_empty_instance


	/**
	* STUB_CHANGE_VALUE
	* Replaces change_value with a counting stub. Keeps the interaction tests
	* client-only: no save request, no write to the shared test3 record.
	* @param {Object} instance
	* @returns {Object} spy: {calls:Array, restore:Function}
	*/
	const stub_change_value = function(instance) {

		const original	= instance.change_value
		const calls		= []

		instance.change_value = function(options) {
			calls.push(options)
			return Promise.resolve(true)
		}

		return {
			calls	: calls,
			restore	: () => { instance.change_value = original }
		}
	}//end stub_change_value


	/** Flush pending microtasks/timers so click handlers settle before asserting. */
	const tick = () => new Promise(resolve => setTimeout(resolve, 0))


	/** Explicit, sized map container — lazy_in_viewport is not deterministic under the runner. */
	const create_map_holder = function(parent, key=0) {

		const map_holder = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'leaflet_map',
			dataset			: { key : key },
			parent			: parent
		})
		map_holder.style.width	= '400px'
		map_holder.style.height	= '300px'

		return map_holder
	}//end create_map_holder



describe(`COMPONENT_GEOLOCATION LIFECYCLE`, function() {

	this.timeout(15000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_geolocation',
					tipo			: tipo,
					section_tipo	: section_tipo,
					section_id		: section_id,
					lang			: lang,
					mode			: pair.mode,
					view			: pair.view,
					id_variant		: pair.mode + '_' + pair.view + '_' + Math.random()
				}

				// init
					instance = await get_instance(options)

					assert.equal(instance.model, 'component_geolocation', 'model expected component_geolocation')
					assert.equal(instance.tipo, tipo, `tipo expected ${tipo}`)
					assert.equal(instance.section_tipo, section_tipo, `section_tipo expected ${section_tipo}`)
					assert.equal(instance.section_id, section_id, `section_id expected ${section_id}`)
					assert.equal(instance.mode, pair.mode, `mode expected ${pair.mode}`)
					assert.equal(instance.lang, lang, `lang expected ${lang}`)

				// build
					await instance.build(true)
					assert.equal(instance.status, 'built', 'status expected built after build')
					assert.isOk(instance.datum, 'datum expected after build')
					assert.isOk(instance.context, 'context expected after build')

				// render
					node = await instance.render()
					assert.equal(instance.status, 'rendered', 'status expected rendered after render')
					assert.isOk(node instanceof Element, 'node expected DOM Element')
			});



			it(`render output structure for ${pair.mode}/${pair.view}`, async function() {

				// insert in DOM for search mode
					if (pair.mode==='search') {
						const search_component = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'search_component',
							parent			: component_container
						})
						search_component.appendChild(node)
					}else{
						component_container.appendChild(node)
					}

				// mode-specific assertions
					if (pair.mode==='edit' && pair.view==='default') {
						// edit default: content_value, map_inputs, leaflet_map
						assert.isOk(node.querySelector('.content_value'), 'expected content_value in edit/default')
						assert.isOk(node.querySelector('.map_inputs'), 'expected map_inputs in edit/default')
						assert.isOk(node.querySelector('.leaflet_map'), 'expected leaflet_map in edit/default')
						// inputs: lat, lon, zoom, alt
						assert.isOk(node.querySelector('.geo_active_input.lat'), 'expected lat input in edit/default')
						assert.isOk(node.querySelector('.geo_active_input.lon'), 'expected lon input in edit/default')
						assert.isOk(node.querySelector('.geo_active_input.zoom'), 'expected zoom input in edit/default')
						assert.isOk(node.querySelector('.altitude'), 'expected alt input in edit/default')
						// buttons: save, fullscreen, refresh
						assert.isOk(node.querySelector('.buttons_container'), 'expected buttons_container in edit/default')
					}

					if (pair.mode==='edit' && pair.view==='line') {
						// edit line: content_data exists, view_line class
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in edit/line')
						assert.isOk(node.classList.contains('view_line'), 'expected view_line class')
					}

					if (pair.mode==='edit' && pair.view==='print') {
						// edit print: permissions forced to 1, read_only content
						const read_only = node.querySelector('.read_only')
						assert.isOk(read_only, 'expected read_only element in edit/print')
					}

					if (pair.mode==='list' && pair.view==='default') {
						// list default: wrapper with list mode class
						assert.isOk(node.classList.contains('list'), 'expected list class in list/default')
					}

					if (pair.mode==='list' && pair.view==='mini') {
						// list mini: mini wrapper
						assert.isOk(node.classList.contains('mini'), 'expected mini class in list/mini')
					}

					if (pair.mode==='list' && pair.view==='text') {
						// list text: span element
						assert.equal(node.nodeName, 'SPAN', 'expected SPAN node in list/text')
					}

					if (pair.mode==='search') {
						// search: content_data (q_operator not created by geolocation search render - under construction)
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in search/default')
					}
			});



			it(`destroy`, async function() {

				if (instance) {
					await instance.destroy(true)
				}

				assert.equal(instance.status, 'destroyed', 'status expected destroyed after destroy')
				assert.equal(instance.node, null, 'node expected null after destroy')
			});
		});
	}//end for (mode_view_pairs)
});



describe(`COMPONENT_GEOLOCATION DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null

	// The canonical single entry of test100 on this suite's own record (test3/14,
	// manifest.ts SUITE_ISOLATION_RECORDS[14]).
	const canonical_entry = {
		alt		: 0,
		lat		: 39.45952823913757,
		lon		: -0.3274998574173816,
		zoom	: 16
	}

	/**
	* SET_SINGLE_ENTRY
	* Puts the component back to EXACTLY one entry via 'set_data'.
	* The write cases below address key 0, and a save whose target key holds no id
	* APPENDS while a remove leaves a null hole — so without this the geo array
	* grows [null,{…},null,…] across runs and key 0 eventually reads null. Used as
	* both the precondition of the write chain and its teardown.
	*/
	async function set_single_entry(target, value) {
		await target.change_value({
			changed_data	: [Object.freeze({
				action	: 'set_data',
				value	: [ {...value} ]
			})],
			refresh			: false
		})
	}

	after(async function() {
		this.timeout(15000)
		// on its OWN instance: the last case of this block destroys `instance`, so
		// a teardown reusing it would silently no-op and leave the record holding
		// the cleared slot the remove case wrote.
		const cleaner = await get_instance({
			model			: 'component_geolocation',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'data_ops_teardown_' + Math.random()
		})
		await cleaner.build(true)
		cleaner.permissions = 2
		await set_single_entry(cleaner, canonical_entry)
		await cleaner.destroy(true, true, true)
	})



	it(`init → build → render (edit mode, permissions=2)`, async function() {

		const options = {
			model			: 'component_geolocation',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'data_ops_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)
		instance.permissions = 2
		node = await instance.render()

		component_container.appendChild(node)

		assert.equal(instance.model, 'component_geolocation', 'model expected component_geolocation')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(instance.datum, 'datum expected')
		assert.isOk(instance.context, 'context expected')
		assert.isOk(instance.data, 'data expected')
		// entries may be undefined/null when component has no stored data
		const entries = instance.data?.entries
		assert.isOk(entries === undefined || entries === null || Array.isArray(entries), 'data.entries expected array, null, or undefined')
	});



	it(`data structure`, async function() {

		const entries = instance.data.entries || []

		// geolocation entries have lat, lon, zoom, alt (no 'value' key)
		if (entries.length > 0) {
			const entry = entries[0]
			assert.isOk('lat' in entry, 'expected lat property in entry')
			assert.isOk('lon' in entry, 'expected lon property in entry')
			assert.isOk('zoom' in entry, 'expected zoom property in entry')
			assert.isOk('alt' in entry, 'expected alt property in entry')
			// geolocation data does NOT have a 'value' key
			assert.isUndefined(entry.value, 'geolocation entry should NOT have value key')
		}
	});



	it(`get_stored_entry / get_view on a record WITH data`, async function() {

		const entries = instance.data.entries || []

		if (entries.length > 0) {
			// stored entry read: the raw entry, no fallback
			assert.deepEqual(instance.get_stored_entry(0), entries[0], 'get_stored_entry expected the stored entry')
			// view read: the stored framing (lat/lon/zoom), not the camera default
			const view = instance.get_view(0)
			assert.equal(view.lat, entries[0].lat, 'get_view.lat expected the stored lat')
			assert.equal(view.lon, entries[0].lon, 'get_view.lon expected the stored lon')
			assert.equal(view.zoom, entries[0].zoom, 'get_view.zoom expected the stored zoom')
		}else{
			assert.isNull(instance.get_stored_entry(0), 'get_stored_entry expected null with no stored entry')
			assert.deepEqual(instance.get_view(0), instance.default_view, 'get_view expected default_view with no stored entry')
		}

		// out-of-range key is absence, never a throw
		assert.isNull(instance.get_stored_entry(99), 'get_stored_entry expected null for an absent key')
		assert.deepEqual(instance.get_view(99), instance.default_view, 'get_view expected default_view for an absent key')
	});



	it(`add data via change_value (set_data)`, async function() {

		// start from EXACTLY one entry, so key 0 addresses a real slot: an update
		// against a key that holds no id appends instead, and the case would then
		// assert key 0 while the value landed at the end of the array.
		await set_single_entry(instance, canonical_entry)

		const key	= 0
		const entries = instance.data.entries || []
		assert.isOk(entries[key], 'setup: exactly one stored entry expected at key 0')

		const new_value = {
			lat		: 40.416775,
			lon		: -3.703790,
			zoom	: 10,
			alt		: 650
		}

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: new_value
		})

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh			: false
		})

		// verify entries updated
		const updated_entries = instance.data.entries
		assert.isOk(updated_entries, 'entries expected after change_value')
		assert.equal(updated_entries.length, 1, 'an update must REPLACE the entry, never append a second one')
		assert.equal(updated_entries[0].lat, 40.416775, 'expected lat 40.416775 after change')
		assert.equal(updated_entries[0].lon, -3.703790, 'expected lon -3.703790 after change')
	});



	it(`change data via change_value (update)`, async function() {

		const key	= 0
		const entries = instance.data.entries || []
		assert.isOk(entries[key], 'setup: the previous case must have left one entry at key 0')

		const item = JSON.parse(JSON.stringify(entries[key]))
		item.lat = 41.3851
		item.lon = 2.1734

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh			: false
		})

		const updated_entries = instance.data.entries
		assert.equal(updated_entries.length, 1, 'an update must REPLACE the entry, never append a second one')
		assert.equal(updated_entries[0].lat, 41.3851, 'expected lat 41.3851 after update')
		assert.equal(updated_entries[0].lon, 2.1734, 'expected lon 2.1734 after update')
	});



	it(`remove data via change_value (remove)`, async function() {

		const key	= 0
		const entries = instance.data.entries || []
		assert.isOk(entries[key], 'setup: the previous case must have left one entry at key 0')

		// A remove NAMES the stored item. (This case used to send `update` with a
		// null value, which the save door now refuses — a null is not an item,
		// WC-2026-10-03-save-refuses-malformed-value-shape — while the client
		// model applied it locally, so the case stayed green with nothing saved.)
		assert.isOk(entries[key].id, 'setup: the stored entry must carry its item id')
		const changed_data_item = Object.freeze({
			action	: 'remove',
			id		: entries[key].id,
			value	: null
		})

		const response = await instance.change_value({
			changed_data	: [changed_data_item],
			refresh			: false,
			remove_dialog	: false
		})
		assert.isTrue(response?.ok, 'the server expected to accept the remove (envelope ok)')

		// the case used to assert NOTHING: the stored coordinate must be gone —
		// not merely "the call returned".
		assert.isNotOk(
			(instance.data.entries || []).some(el => el && el.lat!==undefined),
			'no stored coordinate expected after the remove'
		)
	});



	it(`refresh rebuilds component`, async function() {

		await instance.refresh()

		assert.equal(instance.status, 'rendered', 'status expected rendered after refresh')
		assert.isOk(instance.node, 'node expected after refresh')
	});



	it(`is_empty returns boolean`, async function() {

		const result = is_empty(instance)
		assert.isOk(typeof result === 'boolean', 'is_empty expected boolean return')
	});



	it(`instance id is set`, async function() {

		assert.isOk(instance.id, 'instance.id expected to be set')
		assert.isOk(instance.id.length > 0, 'instance.id expected non-empty string')
	});



	it(`component-specific properties`, async function() {

		// geolocation has default_view: a CAMERA (opening map position), never a value.
		// It replaces the old default_value: no alt (a camera has no altitude) and no
		// magic sentinel — the stored value and the view are different things.
		assert.isOk(instance.default_view, 'default_view expected')
		assert.isOk('lat' in instance.default_view, 'default_view.lat expected')
		assert.isOk('lon' in instance.default_view, 'default_view.lon expected')
		assert.isOk('zoom' in instance.default_view, 'default_view.zoom expected')
		assert.isUndefined(instance.default_view.alt, 'default_view.alt expected undefined (camera has no altitude)')
		assert.isUndefined(instance.default_value, 'default_value expected removed (replaced by default_view)')

		// no fabricated value: the Valencia sentinel must not survive anywhere
		assert.notEqual(instance.default_view.lat, 39.462571, 'default_view.lat must not be the Valencia sentinel')
		assert.notEqual(instance.default_view.lon, -0.376295, 'default_view.lon must not be the Valencia sentinel')

		// geolocation has current_value array
		assert.isOk(Array.isArray(instance.current_value), 'current_value expected array')

		// geo_provider from context features
		const geo_provider = instance.context?.features?.geo_provider
		assert.isOk(geo_provider, 'geo_provider expected in context.features')
	});



	it(`handle_coord_change updates current_value and is_data_changed`, async function() {

		instance.handle_coord_change(0, 'lat', 39.468)

		assert.equal(instance.current_value[0].lat, 39.468, 'lat expected 39.468 after handle_coord_change')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true after handle_coord_change')
	});



	it(`build_changed_data_item creates frozen object`, async function() {

		const changed_data_item = instance.build_changed_data_item(0)

		assert.isOk(Object.isFrozen(changed_data_item), 'changed_data_item expected frozen')
		assert.equal(changed_data_item.action, 'update', 'action expected update')
		assert.isOk(changed_data_item.value, 'value expected in changed_data_item')
	});



	it(`destroy after data operations`, async function() {

		if (instance) {
			await instance.destroy(true)
		}

		assert.equal(instance.status, 'destroyed', 'status expected destroyed')
		assert.equal(instance.node, null, 'node expected null after destroy')

		// clean DOM
			while (component_container.firstChild) {
				component_container.removeChild(component_container.firstChild)
			}
	});
});



// EMPTY RECORD — ABSENCE IS STRUCTURAL
// The engine ALWAYS emits an array for data.entries — `[]` where the PHP oracle
// emitted null (WC-001). A record with no stored geolocation has NO value, and the
// client must not invent one: the four inputs render empty, current_value[0] stays
// undefined and the save button sends nothing. Opening a record and pressing save
// used to store the Valencia sentinel (39.462571 / -0.376295), which the diffusion
// parsers then had to hardcode as "no location" — a magic coordinate in the data.
//
// The map's opening position is a CAMERA (self.default_view: lat/lon/zoom, no alt,
// from context.features.default_view, hard fallback {20, 0, 2}). Resolving it
// stores nothing: the FIRST user action (drag, zoom, typing, drawing) is what
// creates the value, and only an explicit save commits it.
// Reported against numisdata6/564 (component numisdata264).
describe(`COMPONENT_GEOLOCATION EMPTY RECORD (no stored value)`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null
	let map_holder	= null



	it(`default_view is the camera; get_stored_entry reports absence`, async function() {

		instance = await build_empty_instance('empty_entries')

		assert.isOk(is_empty(instance), 'instance expected empty with entries: []')

		// camera shape: lat/lon/zoom, NO alt
		const default_view = instance.default_view
		assert.isOk(default_view, 'default_view expected')
		assert.isUndefined(default_view.alt, 'default_view.alt expected undefined (camera has no altitude)')

		// The camera is SERVER-configured: the full edit context always carries
		// features.default_view (structure_context.ts; gate:
		// test/unit/structure_context_geolocation_features.test.ts), and the
		// instance takes it verbatim. Asserted unconditionally — a branch on the
		// key's presence would pass whether or not the server emits it.
		const context_default_view = instance.context?.features?.default_view
		assert.isOk(context_default_view, 'context.features.default_view expected from the server')
		assert.equal(default_view.lat, context_default_view.lat, 'default_view.lat expected from context.features.default_view')
		assert.equal(default_view.lon, context_default_view.lon, 'default_view.lon expected from context.features.default_view')
		assert.equal(default_view.zoom, context_default_view.zoom, 'default_view.zoom expected from context.features.default_view')

		// absence, not a fabricated entry
		assert.isNull(instance.get_stored_entry(0), 'get_stored_entry(0) expected null with no stored value')
		assert.deepEqual(instance.get_view(0), default_view, 'get_view(0) expected default_view with no stored value')

		// get_entries is REPLACED — it existed only to fabricate the fallback entry
		assert.isUndefined(instance.get_entries, 'get_entries expected removed (replaced by get_stored_entry/get_view)')
	});



	it(`renders the four inputs EMPTY and fabricates no value`, async function() {

		node = await instance.render()
		component_container.appendChild(node)

		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(node.querySelector('.leaflet_map'), 'expected leaflet_map container')

		const lat_node	= node.querySelector('.geo_active_input.lat')
		const lon_node	= node.querySelector('.geo_active_input.lon')
		const zoom_node	= node.querySelector('.geo_active_input.zoom')
		const alt_node	= node.querySelector('.altitude')
		assert.isOk(lat_node, 'expected lat input')
		assert.isOk(lon_node, 'expected lon input')
		assert.isOk(zoom_node, 'expected zoom input')
		assert.isOk(alt_node, 'expected alt input')

		assert.equal(lat_node.value, '', 'lat input expected empty on a record with no value')
		assert.equal(lon_node.value, '', 'lon input expected empty on a record with no value')
		assert.equal(zoom_node.value, '', 'zoom input expected empty on a record with no value')
		assert.equal(alt_node.value, '', 'alt input expected empty on a record with no value')

		// (!) the defect: the view seeded current_value[0] at render time
		assert.isUndefined(instance.current_value[0], 'current_value[0] expected undefined until the user acts')
	});



	it(`build_changed_data_item(0) returns null on an untouched empty record`, async function() {

		assert.isNull(instance.build_changed_data_item(0), 'build_changed_data_item expected null with no value to send')
	});



	it(`the save button is a NO-OP on an untouched empty record`, async function() {

		const spy = stub_change_value(instance)

		const save_node = node.querySelector('.button.save')
		assert.isOk(save_node, 'expected save button (permissions=2, show_interface.button_save)')

		save_node.click()
		await tick()

		assert.equal(spy.calls.length, 0, 'save expected to send nothing when there is no value')

		spy.restore()
	});



	it(`get_map opens the map on default_view (camera, not a value)`, async function() {

		// explicit container: the view defers get_map until the node enters the
		// viewport (lazy_in_viewport), which is not deterministic under the runner
		map_holder = create_map_holder(component_container, 0)

		await instance.get_map(map_holder, 0)

		assert.isOk(instance.map, 'Leaflet map expected after get_map on an empty record')
		assert.equal(instance.map.getCenter().lat, instance.default_view.lat, 'map centre lat expected default_view.lat')
		assert.equal(instance.map.getCenter().lng, instance.default_view.lon, 'map centre lon expected default_view.lon')
		assert.equal(instance.map.getZoom(), instance.default_view.zoom, 'map zoom expected default_view.zoom')
		assert.isOk(map_holder.children.length > 0, 'expected Leaflet DOM inside the map container')

		// opening the map is not editing: still no value, still nothing to send
		assert.isUndefined(instance.current_value[0], 'current_value[0] expected still undefined after get_map')
		assert.isNull(instance.build_changed_data_item(0), 'build_changed_data_item expected still null after get_map')
	});



	it(`typing a coordinate creates the value (first user action)`, async function() {

		instance.handle_coord_change(0, 'lat', 41.6523)

		assert.isOk(instance.current_value[0], 'current_value[0] expected created by the first coordinate entry')
		assert.equal(instance.current_value[0].lat, 41.6523, 'lat expected 41.6523')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true')

		const changed_data_item = instance.build_changed_data_item(0)
		assert.isNotNull(changed_data_item, 'build_changed_data_item expected non-null once a value exists')
		assert.equal(changed_data_item.value.lat, 41.6523, 'changed_data_item.value.lat expected 41.6523')
	});



	it(`0 is a legal coordinate, not absence`, async function() {

		instance.handle_coord_change(0, 'lat', 0)
		instance.handle_coord_change(0, 'lon', 0)

		const changed_data_item = instance.build_changed_data_item(0)
		assert.isNotNull(changed_data_item, 'build_changed_data_item expected non-null with 0/0 (Gulf of Guinea)')
		assert.strictEqual(changed_data_item.value.lat, 0, 'lat 0 expected preserved')
		assert.strictEqual(changed_data_item.value.lon, 0, 'lon 0 expected preserved')
	});



	it(`map_update_coordinates ignores a caller with empty entries`, async function() {

		// the update_value observer (e.g. numisdata585 → numisdata264): an empty
		// caller portal emits `[]`, which must be a no-op, not a TypeError
		const caller = {
			data					: { entries: [] },
			datum					: { data: [] },
			request_config_object	: {}
		}

		await instance.map_update_coordinates({ caller: caller })
	});



	it(`refresh restores absence and stays absent after the map animation window`, async function() {

		// state carried from the tests above: current_value[0] holds 0/0
		assert.isOk(instance.current_value[0], 'precondition: a value exists before refresh')

		const refresh_node = node.querySelector('.map_reload')
		assert.isOk(refresh_node, 'expected refresh button')

		refresh_node.click()

		assert.isUndefined(instance.current_value[0], 'current_value[0] expected deleted by refresh (the record stores nothing)')
		assert.isFalse(instance.is_data_changed, 'is_data_changed expected false right after refresh')

		// (!) THE REGRESSION THIS PINS: the camera used to be moved with
		// panTo + setZoom. setZoom fires zoomend ASYNCHRONOUSLY (~250ms) and that
		// handler calls update_input_values, which re-creates current_value[0] from
		// the map CENTRE and re-marks the component dirty — AFTER fn_refresh has
		// returned. The camera (20/0) silently became a saveable value again.
		await new Promise(resolve => setTimeout(resolve, 700))

		assert.isUndefined(instance.current_value[0], 'current_value[0] expected STILL undefined after the zoom animation window')
		assert.isFalse(instance.is_data_changed, 'is_data_changed expected STILL false after the zoom animation window')
		assert.isNull(instance.build_changed_data_item(0), 'build_changed_data_item expected null after refresh')
		assert.equal(node.querySelector('.geo_active_input.lat').value, '', 'lat input expected blank after refresh')
	});



	it(`destroy empty-record instance`, async function() {

		if (instance) {
			await instance.destroy(true)
		}

		assert.equal(instance.status, 'destroyed', 'status expected destroyed')

		// clean DOM
			while (component_container.firstChild) {
				component_container.removeChild(component_container.firstChild)
			}
	});
});



// FIRST-VALUE CREATION ON AN EMPTY RECORD
// Every path below writes into current_value[key] on a record that has NO value yet.
// With the fabricated render-time seed gone, current_value[key] is undefined here and
// each of these paths needs its own creation guard. These are the exact call sites:
// update_draw_data (drawing/create_point), layer_data_change (geo-tag insert), and
// map_update_coordinates from a POPULATED caller.
describe(`COMPONENT_GEOLOCATION EMPTY RECORD FIRST-VALUE CREATION`, function() {

	this.timeout(20000);



	it(`drawing a shape on an empty record creates the value`, async function() {

		const instance	= await build_empty_instance('empty_draw')
		const node		= await instance.render()
		component_container.appendChild(node)

		const map_holder = create_map_holder(component_container, 0)
		await instance.get_map(map_holder, 0)
		assert.isOk(instance.map, 'Leaflet map expected')

		// seed the active FeatureGroup directly: the layer control is provider-dependent
		// and whenReady's layers_loader is not deterministic under the runner
		instance.ar_layer_loaded = [{
			layer_id	: instance.active_layer_id,
			layer_data	: []
		}]
		instance.FeatureGroup[instance.active_layer_id] = new L.FeatureGroup().addTo(instance.map)

		// the geometry path: create_point → update_draw_data
		// (!) update_draw_data writes current_value[key].lib_data — undefined here
		instance.create_point({ lat: 41.7665, lng: -2.4790 })

		assert.isOk(instance.current_value[0], 'current_value[0] expected created by the first drawn geometry')
		assert.isOk(Array.isArray(instance.current_value[0].lib_data), 'lib_data expected array')

		const layer = instance.current_value[0].lib_data.find(item => item.layer_id===instance.active_layer_id)
		assert.isOk(layer, 'expected the active layer in lib_data')
		assert.equal(layer.layer_data.features.length, 1, 'expected one drawn feature')

		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true after drawing')

		const changed_data_item = instance.build_changed_data_item(0)
		assert.isNotNull(changed_data_item, 'build_changed_data_item expected non-null after drawing')
		assert.isOk(changed_data_item.value.lib_data, 'changed_data_item.value.lib_data expected')

		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	});



	it(`geo-tag insert on an empty record creates the value`, async function() {

		const instance	= await build_empty_instance('empty_tag')
		const node		= await instance.render()
		component_container.appendChild(node)

		const map_holder = create_map_holder(component_container, 0)
		await instance.get_map(map_holder, 0)

		// layer_data_change('insert') renders the new layer: it needs a layer control
		// and an initialised ar_layer_loaded, both provider/timing dependent here
		instance.ar_layer_loaded	= []
		instance.layer_control		= instance.layer_control || L.control.layers({}).addTo(instance.map)
		// (!) NO db_data STUB. This used to seed `{value:[]}` because the insert
		// branch's `.then()` wrote `db_data.value[key]` — a phantom key that threw
		// on every real run (component data carries `entries`, never `value`).
		// That line is gone: save() owns the baseline, so the stub would only
		// hide the shape from the test.

		const spy = stub_change_value(instance)

		// the component_text_area tag bridge: inserting a geo-tag on an empty record
		// (!) writes current_value[key].lib_data — undefined here
		instance.layer_data_change({
			action	: 'insert',
			tag_id	: 7,
			type	: 'geo'
		})
		await tick()

		assert.isOk(instance.current_value[0], 'current_value[0] expected created by the geo-tag insert')
		assert.isOk(Array.isArray(instance.current_value[0].lib_data), 'lib_data expected array')
		assert.isOk(
			instance.current_value[0].lib_data.find(item => item.layer_id===7),
			'expected the inserted layer 7 in lib_data'
		)
		assert.equal(spy.calls.length, 1, 'expected one change_value call for the inserted layer')

		spy.restore()
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	});



	it(`map_update_coordinates copies a POPULATED caller onto an empty record`, async function() {

		const instance	= await build_empty_instance('empty_observer')
		const node		= await instance.render()
		component_container.appendChild(node)

		// the real view container: map_update_coordinates → update_input_values reads
		// node.content_data[key].map_container and its sibling inputs
		const map_container = node.content_data[0].map_container
		await instance.get_map(map_container, 0)
		assert.isOk(instance.map, 'Leaflet map expected')

		const spy = stub_change_value(instance)

		// the numisdata585 → numisdata264 update_value observer shape: the caller portal
		// holds the selected record, its datum carries that record's geolocation data
		const caller = {
			data					: { entries : [ { section_tipo: 'test3', section_id: 2 } ] },
			datum					: { data : [ {
				tipo		: 'hierarchy31', // the default target_geolocation_tipo
				section_id	: 2,
				entries		: [ { lat: 41.6523, lon: -4.7245, zoom: 9, alt: 0 } ]
			} ] },
			request_config_object	: {}
		}

		await instance.map_update_coordinates({ caller: caller })

		assert.isOk(instance.current_value[0], 'current_value[0] expected created by the observer update')
		assert.equal(instance.current_value[0].lat, 41.6523, 'lat expected copied from the caller')
		assert.equal(instance.current_value[0].lon, -4.7245, 'lon expected copied from the caller')
		assert.equal(instance.current_value[0].zoom, 9, 'zoom expected copied from the caller')

		// the map actually MOVED to the borrowed point.
		// (!) THE REGRESSION THIS PINS: the move was panTo + setZoom, and the zoom
		// cancels the pan animation — the map never left the camera. Worse, the
		// map's own zoomend handler then wrote that camera centre back into
		// current_value, so the observer stored 20/0 instead of the borrowed
		// coordinates. One setView({animate:false}), before the value is written.
		assert.closeTo(instance.map.getCenter().lat, 41.6523, 0.0001, 'map centre lat expected the borrowed lat')
		assert.closeTo(instance.map.getCenter().lng, -4.7245, 0.0001, 'map centre lon expected the borrowed lon')
		assert.equal(instance.map.getZoom(), 9, 'map zoom expected the borrowed zoom')

		// inputs reflect the borrowed coordinates
		const lat_node = node.querySelector('.geo_active_input.lat')
		assert.equal(parseFloat(lat_node.value), 41.6523, 'lat input expected updated')

		// and the borrowed value IS a value: it is sent
		assert.equal(spy.calls.length, 1, 'expected one change_value call')
		assert.equal(spy.calls[0].changed_data[0].value.lat, 41.6523, 'changed_data value.lat expected 41.6523')

		spy.restore()
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	});
});



// SETTING THE VIEW IS DATA
// lat/lon/zoom are THE VIEW — the map framing an operator chose — and they are
// savable data, independent of any drawn feature (lib_data). Panning and zooming
// is how the view gets set, and the input fields track it live because reading
// the coordinates while moving the map is how an operator approximates a
// position. So a gesture CREATES the view on an empty record, marks the
// component dirty, and the save button commits it.
//
// The defect this suite pins is the refusal that used to sit here: a previous
// revision classified pan/zoom as "navigation, not data entry" and refused to
// write from it, so on a record with no stored value the view could never be
// created and the save button logged "the record has no value to send". The
// intent parameter and its guard are deleted.
//
// What still stops a FABRICATED value, and is asserted below:
//  a) rendering/opening a record seeds nothing — an untouched record yields null
//     from build_changed_data_item;
//  b) a gesture only marks dirty, it never commits;
//  c) the component's OWN camera moves (move_camera / fit_camera_to_geometry)
//     run under camera_is_moving and write nothing at all.
describe(`COMPONENT_GEOLOCATION SETTING THE VIEW IS DATA`, function() {

	this.timeout(20000);

	/** Leaflet fires zoomend/dragend asynchronously (~250ms) for animated moves. */
	const settle = () => new Promise(resolve => setTimeout(resolve, 700))

	/** Builds a rendered empty instance with a live map on the REAL view container. */
	const build_mapped_instance = async function(id_variant) {

		const instance	= await build_empty_instance(id_variant)
		const node		= await instance.render()
		component_container.appendChild(node)

		const map_container = node.content_data[0].map_container
		await instance.get_map(map_container, 0)
		assert.isOk(instance.map, 'Leaflet map expected')

		return { instance, node, map_container }
	}

	const teardown = async function(instance) {
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	}



	it(`an UNTOUCHED record still stores nothing`, async function() {

		// (a): rendering the component and creating the map is not the operator
		// acting. No gesture ran, so no entry exists and there is nothing to send.
		// Map creation and the lazy init must not fire an UNMASKED dragend/zoomend
		// either — that is what this settle window checks.
		const { instance, node } = await build_mapped_instance('view_untouched')

		await settle()

		assert.isUndefined(instance.current_value[0], 'current_value[0] expected undefined on an untouched record')
		assert.notStrictEqual(instance.is_data_changed, true, 'is_data_changed expected not true without a gesture')
		assert.isNull(instance.build_changed_data_item(0), 'build_changed_data_item expected null on an untouched record')
		assert.equal(node.querySelector('.geo_active_input.lat').value, '', 'lat input expected blank')
		assert.equal(node.querySelector('.geo_active_input.lon').value, '', 'lon input expected blank')
		assert.equal(node.querySelector('.geo_active_input.zoom').value, '', 'zoom input expected blank')

		await teardown(instance)
	});



	it(`a map ZOOM on an empty record CREATES the view`, async function() {

		// THE REPORTED BUG: this used to be refused, so a record with no stored
		// value could never save the framing an operator set by hand.
		const { instance, node } = await build_mapped_instance('view_zoom_empty')

		assert.isUndefined(instance.current_value[0], 'precondition: no value')

		instance.map.setZoom(instance.map.getZoom() + 1)
		await settle()
		// belt and braces: fire the event directly too, in case the runner's
		// headless container swallowed the animated one
		instance.map.fire('zoomend')

		assert.isOk(instance.current_value[0], 'current_value[0] expected CREATED by the zoom')
		assert.strictEqual(instance.current_value[0].zoom, instance.map.getZoom(), 'zoom expected taken from the map')
		assert.closeTo(instance.current_value[0].lat, instance.map.getCenter().lat, 0.0001, 'lat expected taken from the map centre')
		assert.closeTo(instance.current_value[0].lon, instance.map.getCenter().lng, 0.0001, 'lon expected taken from the map centre')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true: setting the view is real work')

		// and it is savable: both save-button gates now pass
		const changed_data_item = instance.build_changed_data_item(0)
		assert.isNotNull(changed_data_item, 'build_changed_data_item expected non-null after a zoom')
		assert.closeTo(changed_data_item.value.lat, instance.map.getCenter().lat, 0.0001, 'the sent value expected to carry the view')

		// the inputs TRACK the map live — that readout is the point of the gesture
		assert.equal(parseFloat(node.querySelector('.geo_active_input.zoom').value), instance.map.getZoom(), 'zoom input expected updated')
		assert.closeTo(parseFloat(node.querySelector('.geo_active_input.lat').value), instance.map.getCenter().lat, 0.0001, 'lat input expected updated')

		// (b) nothing auto-saved: only the save button commits
		assert.isOk(Array.isArray(instance.data.changed_data)===false || instance.data.changed_data.length===0, 'no changed_data expected: a gesture does not commit')

		await teardown(instance)
	});



	it(`a map DRAG on an empty record CREATES the view`, async function() {

		const { instance, node } = await build_mapped_instance('view_drag_empty')

		instance.map.panBy([120, 90], {animate:false})
		instance.map.fire('dragend')
		await settle()

		assert.isOk(instance.current_value[0], 'current_value[0] expected CREATED by the drag')
		assert.closeTo(instance.current_value[0].lat, instance.map.getCenter().lat, 0.0001, 'lat expected taken from the map centre')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true after a drag')
		assert.isNotNull(instance.build_changed_data_item(0), 'build_changed_data_item expected non-null after a drag')
		assert.closeTo(parseFloat(node.querySelector('.geo_active_input.lat').value), instance.map.getCenter().lat, 0.0001, 'lat input expected updated')

		await teardown(instance)
	});



	it(`a PROGRAMMATIC move writes nothing (camera_is_moving)`, async function() {

		// (c): move_camera is the component's own door, not the operator's. Its
		// dragend/zoomend feedback is masked, so it can neither create a view on
		// an empty record nor overwrite one with Leaflet's rounded centre.
		const { instance } = await build_mapped_instance('view_programmatic_move')

		instance.move_camera(41.6523, -4.7245, 9)
		await settle()

		assert.isUndefined(instance.current_value[0], 'current_value[0] expected STILL undefined after a programmatic move')
		assert.notStrictEqual(instance.is_data_changed, true, 'is_data_changed expected not true after a programmatic move')
		assert.isNull(instance.build_changed_data_item(0), 'build_changed_data_item expected null after a programmatic move')
		assert.isFalse(instance.camera_is_moving, 'camera_is_moving expected lowered after the move')

		await teardown(instance)
	});



	it(`a map zoom on a record that HAS a coordinate UPDATES the view`, async function() {

		// the live readout on a populated record: the same gesture, same law
		const { instance, node } = await build_mapped_instance('view_zoom_valued')

		instance.handle_coord_change(0, 'lat', 41.6523)
		instance.handle_coord_change(0, 'lon', -4.7245)
		instance.is_data_changed = false

		instance.map.setZoom(9)
		instance.map.fire('zoomend')
		await settle()

		assert.isOk(instance.current_value[0], 'current_value[0] expected to survive')
		assert.equal(instance.current_value[0].zoom, instance.map.getZoom(), 'zoom expected re-framed from the camera')
		assert.closeTo(instance.current_value[0].lat, instance.map.getCenter().lat, 0.0001, 'lat expected re-framed from the camera')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true: re-framing a value is real work')
		assert.equal(parseFloat(node.querySelector('.geo_active_input.zoom').value), instance.map.getZoom(), 'zoom input expected updated')

		await teardown(instance)
	});



	it(`a map zoom on a record that carries FEATURES sets the view and leaves them alone`, async function() {

		// the view and the features are INDEPENDENT: the gesture writes lat/lon/
		// zoom and does not touch, derive from, or drop lib_data.
		const { instance } = await build_mapped_instance('view_zoom_features')

		const lib_data = [{
			layer_id	: instance.active_layer_id,
			layer_data	: { type:'FeatureCollection', features:[{
				type		: 'Feature',
				properties	: {},
				geometry	: { type:'Point', coordinates:[3.14754, 41.858199] }
			}]}
		}]
		instance.current_value[0] = { lib_data : lib_data }
		instance.is_data_changed = false

		instance.map.setZoom(7)
		instance.map.fire('zoomend')
		await settle()

		assert.isOk(Number.isFinite(instance.current_value[0].lat), 'lat expected written as the view')
		assert.strictEqual(instance.current_value[0].zoom, instance.map.getZoom(), 'zoom expected the map zoom')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true')
		assert.deepEqual(instance.current_value[0].lib_data, lib_data, 'the drawn features expected untouched by a view change')

		await teardown(instance)
	});



	it(`update_input_values writes on a plain 3-argument call`, async function() {

		// the intent parameter is DELETED: there is no caller that may not write.
		// A fourth argument, if any survived somewhere, must change nothing.
		const { instance, map_container } = await build_mapped_instance('view_no_intent_param')

		const written = instance.update_input_values(0, {lat:20, lon:0, zoom:2}, map_container)

		assert.isTrue(written, 'a 3-argument call expected to write')
		assert.equal(instance.current_value[0].lat, 20, 'lat expected written on a record that had no value')
		assert.isTrue(instance.is_data_changed, 'is_data_changed expected true')

		assert.strictEqual(instance.update_input_values.length, 3, 'update_input_values expected exactly three parameters (no intent switch)')

		await teardown(instance)
	});



	it(`typing lat then zoom KEEPS the typed coordinate (no rounded camera write-back)`, async function() {

		const { instance, node } = await build_mapped_instance('nav_typed_coord')

		// the real sequence: the user types into the input, whose change event calls
		// handle_coord_change. The input text must be set here too — it is what the
		// camera write-back used to overwrite, and handle_coord_change never writes
		// it back (the input IS the event source).
		const lat_node	= node.querySelector('.geo_active_input.lat')
		const lon_node	= node.querySelector('.geo_active_input.lon')
		lat_node.value	= '41.6523'
		instance.handle_coord_change(0, 'lat', 41.6523)
		lon_node.value	= '-4.7245'
		instance.handle_coord_change(0, 'lon', -4.7245)
		node.querySelector('.geo_active_input.zoom').value = '9'
		instance.handle_coord_change(0, 'zoom', 9)

		await settle()

		// strict, not closeTo: the defect was Leaflet's PIXEL-ROUNDED getCenter()
		// (41.6523 → 41.65229…) being written back over the exact typed value by an
		// async zoomend. move_camera + camera_is_moving is what makes this hold.
		assert.strictEqual(instance.current_value[0].lat, 41.6523, 'typed lat expected preserved EXACTLY')
		assert.strictEqual(instance.current_value[0].lon, -4.7245, 'typed lon expected preserved EXACTLY')
		assert.strictEqual(instance.current_value[0].zoom, 9, 'typed zoom expected preserved')
		assert.strictEqual(lat_node.value, '41.6523', 'lat input expected untouched by the camera')
		assert.strictEqual(lon_node.value, '-4.7245', 'lon input expected untouched by the camera')

		await teardown(instance)
	});



	it(`build_changed_data_item RECOVERS the id from the stored entry (second save REPLACES)`, async function() {

		// the client half of the append-vs-replace contract: component_geolocation is
		// not translatable, so the server's applyUpdate takes the non-sliced branch —
		// an id-less 'update' APPENDS. The first save's id lands in self.data (the
		// server stamps it), never in the client's current_value buffer, so without
		// this recovery the second save doubled the item and the map reloaded at the
		// stale first position. Server twin: test/unit/save_component_geolocation_item_id.test.ts
		const instance = await build_empty_instance('nav_id_recovery')

		// the shape after a first save: the server returned the item WITH an id
		instance.data.entries	= [ {id:7, lat:41.6523, lon:-4.7245, zoom:9, alt:null} ]
		// the client's own buffer, edited since, still id-less
		instance.current_value[0] = {lat:42.1, lon:-3.9, zoom:10, alt:null}

		const changed_data_item = instance.build_changed_data_item(0)

		assert.isNotNull(changed_data_item, 'changed_data_item expected')
		assert.strictEqual(changed_data_item.id, 7, 'id expected recovered from the stored entry')
		assert.strictEqual(instance.current_value[0].id, 7, 'id expected stamped back into current_value for later saves')
		assert.equal(changed_data_item.value.lat, 42.1, 'the EDITED value expected sent, not the stored one')

		// and a genuinely new value still sends id null — the server owns allocation
		const fresh = await build_empty_instance('nav_id_fresh')
		fresh.current_value[0] = {lat:0, lon:0, zoom:2, alt:null}
		assert.isNull(fresh.build_changed_data_item(0).id, 'a first save expected id null (server allocates)')

		await fresh.destroy(true)
		await instance.destroy(true)
	});
});



// GEOMETRY FRAMES ITSELF
// A record whose value is a drawn shape and NO coordinate is the normal product
// of the new law (update_draw_data creates `{lib_data:[…]}`; the import path's
// geometry-only branch creates the same shape). The old client could not produce
// it: it always fabricated a centre, so a coordinate always rode along.
//
// Two consequences this suite pins:
//  a) the map must OPEN on the drawing. Opening on the world camera put the
//     operator's own work off-screen — it read as lost work (P2-F4). The centre
//     is DERIVED (bbox of every feature across every lib_data layer, the same
//     rule the migration uses) and it is CAMERA ONLY: nothing here is ever
//     stored, sent, or marked dirty.
//  b) absence must RENDER EMPTY. A geometry-only entry has no lat/lon/zoom, and
//     assigning undefined to an input node renders the literal string
//     'undefined' in the VALUE fields, which fn_click_add_point and
//     handle_coord_change read straight back (P2-F10).
//
// The framing law's other half is the server's: when an item carries lib_data
// features, all three publication paths take the GEOMETRY as the record's
// location and the stored centre is framing, never a coordinate claim
// (src/diffusion/resolve/default_value.ts, parsers/parser_misc.ts geoGeojson,
// resolve/ddo_fns.ts buildGeojsonLayers). Server twin:
// test/unit/diffusion_geo_precedence.test.ts.
describe(`COMPONENT_GEOLOCATION GEOMETRY FRAMES ITSELF`, function() {

	this.timeout(20000);

	/** Leaflet fires zoomend/dragend asynchronously (~250ms) for animated moves. */
	const settle = () => new Promise(resolve => setTimeout(resolve, 700))

	/** A drawn single Point — bbox centre IS the point, returned verbatim/unrounded. */
	const POINT_LON = 3.14754
	const POINT_LAT = 41.858199
	const point_geometry = () => [{
		layer_id	: 'geolocation_layer',
		layer_data	: { type:'FeatureCollection', features:[{
			type		: 'Feature',
			properties	: {},
			geometry	: { type:'Point', coordinates:[POINT_LON, POINT_LAT] }
		}]}
	}]

	/** A drawn LineString — a real bbox: centre is neither vertex. */
	const line_geometry = () => [{
		layer_id	: 'geolocation_layer',
		layer_data	: { type:'FeatureCollection', features:[{
			type		: 'Feature',
			properties	: {},
			geometry	: { type:'LineString', coordinates:[[-2.246499, 41.34355], [-1.246381, 41.877469]] }
		}]}
	}]

	/**
	* Builds a rendered instance whose STORED value is `entry` (data.entries), with
	* a live map. Mirrors build_mapped_instance but seeds the stored side.
	*/
	const build_stored_instance = async function(id_variant, entry) {

		const instance = await build_empty_instance(id_variant)
		instance.data.entries = [entry]

		const node = await instance.render()
		component_container.appendChild(node)

		const map_container = node.content_data[0].map_container
		await instance.get_map(map_container, 0)
		assert.isOk(instance.map, 'Leaflet map expected')

		return { instance, node, map_container }
	}

	const teardown = async function(instance) {
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	}



	it(`a GEOMETRY-ONLY record opens ON its geometry, not the world view`, async function() {

		// no map needed: get_view/get_geometry_bounds are pure camera maths
		const instance = await build_empty_instance('geo_frame_view')
		instance.data.entries = [ {id:11, lib_data:point_geometry()} ]

		const view = instance.get_view(0)

		assert.strictEqual(view.lat, POINT_LAT, 'camera lat expected the drawn point (verbatim, unrounded)')
		assert.strictEqual(view.lon, POINT_LON, 'camera lon expected the drawn point (verbatim, unrounded)')
		assert.notStrictEqual(view.lat, instance.default_view.lat, 'camera expected NOT the world view lat')
		assert.notStrictEqual(view.lon, instance.default_view.lon, 'camera expected NOT the world view lon')
		assert.strictEqual(view.zoom, instance.default_view.zoom, 'zoom expected the default: the entry carries none')

		// the bbox of a single point is the point itself, in Leaflet [[S,W],[N,E]]
		assert.deepEqual(
			instance.get_geometry_bounds(0),
			[[POINT_LAT, POINT_LON], [POINT_LAT, POINT_LON]],
			'get_geometry_bounds expected the point own bbox'
		)

		// a real extent: the centre is neither vertex, and it matches the
		// migration script fitViewToGeometry byte-for-byte (tchi1 numbers)
		const line_instance = await build_empty_instance('geo_frame_view_line')
		line_instance.data.entries = [ {id:12, lib_data:line_geometry()} ]
		const line_view = line_instance.get_view(0)
		assert.strictEqual(line_view.lat, 41.61051, 'LineString camera lat expected the bbox centre')
		assert.strictEqual(line_view.lon, -1.74644, 'LineString camera lon expected the bbox centre')

		// and absence is still absence: no geometry, no coordinate → world view
		const empty_instance = await build_empty_instance('geo_frame_view_empty')
		assert.strictEqual(empty_instance.get_view(0), empty_instance.default_view, 'a valueless record expected the world view')
		assert.isNull(empty_instance.get_geometry_bounds(0), 'no entry expected null bounds')

		await empty_instance.destroy(true)
		await line_instance.destroy(true)
		await instance.destroy(true)
	});



	it(`the derived camera is NEVER stored`, async function() {

		// the whole point of deriving in get_view instead of writing a centre:
		// the record must stay geometry-only until the operator decides otherwise
		const { instance } = await build_stored_instance('geo_frame_not_stored', {id:13, lib_data:point_geometry()})

		// get_map already framed it; do it again explicitly
		assert.isTrue(instance.fit_camera_to_geometry(0), 'fit expected to run on a coordinate-less geometry record')
		await settle()

		assert.isUndefined(instance.current_value[0].lat, 'current_value lat expected STILL undefined')
		assert.isUndefined(instance.current_value[0].lon, 'current_value lon expected STILL undefined')
		assert.notStrictEqual(instance.is_data_changed, true, 'is_data_changed expected not true: framing is not an edit')

		const changed_data_item = instance.build_changed_data_item(0)
		assert.isUndefined(changed_data_item?.value?.lat, 'the sent value expected to carry NO lat')
		assert.isUndefined(changed_data_item?.value?.lon, 'the sent value expected to carry NO lon')

		// the stored side is untouched too
		assert.isUndefined(instance.data.entries[0].lat, 'the stored entry expected untouched')

		await teardown(instance)
	});



	it(`fitBounds does not feed itself back as data`, async function() {

		// a fit is the component's OWN move, not the operator's, so it must write
		// nothing. camera_is_moving is what makes it inert, and it must be raised
		// for the whole fit.
		const { instance } = await build_stored_instance('geo_frame_no_feedback', {id:14, lib_data:line_geometry()})

		// move away first, through the component own guarded door, so the fit
		// really changes the view (and so this move writes nothing either)
		instance.move_camera(20, 0, 2)
		await settle()
		instance.is_data_changed = false

		const observed = []
		const record_guard = () => observed.push(instance.camera_is_moving)
		instance.map.on('zoomend', record_guard)
		instance.map.on('moveend', record_guard)

		assert.isTrue(instance.fit_camera_to_geometry(0), 'fit expected to run')

		// a synchronous feedback event fired INSIDE the fit must see the guard up
		assert.isAbove(observed.length, 0, 'expected at least one map event during the fit')
		assert.deepEqual(
			observed.filter(flag => flag!==true),
			[],
			'camera_is_moving expected TRUE for every map event fired during the fit'
		)
		assert.isFalse(instance.camera_is_moving, 'camera_is_moving expected lowered after the fit')

		await settle()
		instance.map.off('zoomend', record_guard)
		instance.map.off('moveend', record_guard)

		assert.isUndefined(instance.current_value[0].lat, 'the fitted centre expected NOT written as data')
		assert.notStrictEqual(instance.is_data_changed, true, 'is_data_changed expected not true after a fit')

		await teardown(instance)
	});



	it(`a stored coordinate on a geometry record WINS over the derived one`, async function() {

		// the D1 framing law, client half: on a geometry record the stored lat/lon
		// is the operator OWN chosen framing (publication reads the geometry as the
		// location), so it is obeyed as-is and never re-derived.
		const { instance } = await build_stored_instance('geo_frame_stored_wins', {
			id			: 15,
			lat			: 40.416775,
			lon			: -3.703790,
			zoom		: 11,
			lib_data	: point_geometry()
		})

		const view = instance.get_view(0)
		assert.strictEqual(view.lat, 40.416775, 'stored lat expected to win over the derived centre')
		assert.strictEqual(view.lon, -3.703790, 'stored lon expected to win over the derived centre')
		assert.strictEqual(view.zoom, 11, 'stored zoom expected to win')
		assert.notStrictEqual(view.lat, POINT_LAT, 'the derived centre expected NOT used')

		assert.isFalse(instance.fit_camera_to_geometry(0), 'fit expected REFUSED when the entry has a coordinate')

		// the bounds are still readable — refusing to fit is a policy, not blindness
		assert.isNotNull(instance.get_geometry_bounds(0), 'geometry bounds expected still resolvable')

		await teardown(instance)
	});



	it(`refresh on a GEOMETRY-ONLY record leaves the inputs EMPTY`, async function() {

		// P2-F10: `input.value = undefined` renders the literal string 'undefined'
		// in the VALUE fields. fn_click_add_point and handle_coord_change read those
		// fields back, so a rendered 'undefined' is one click away from the record.
		const { instance, node } = await build_stored_instance('geo_frame_refresh', {id:16, lib_data:point_geometry()})

		// dirty the inputs the way a user would, so refresh has something to restore
		const lat_node	= node.querySelector('.geo_active_input.lat')
		const lon_node	= node.querySelector('.geo_active_input.lon')
		const zoom_node	= node.querySelector('.geo_active_input.zoom')
		const alt_node	= node.querySelector('.altitude')
		lat_node.value	= '41.6523'
		lon_node.value	= '-4.7245'
		zoom_node.value	= '9'
		alt_node.value	= '120'

		node.querySelector('.map_reload').click()
		await settle()

		const rendered = [lat_node.value, lon_node.value, zoom_node.value, alt_node.value]
		assert.deepEqual(rendered, ['', '', '', ''], 'all four inputs expected EMPTY after refreshing a geometry-only record')
		assert.deepEqual(
			rendered.filter(value => String(value).indexOf('undefined')!==-1),
			[],
			'no input expected to render the string undefined'
		)

		// and the buffer is the stored entry verbatim — absence is not persisted as ''
		assert.isUndefined(instance.current_value[0].lat, 'current_value lat expected undefined, never an empty string')
		assert.isOk(instance.current_value[0].lib_data, 'the drawn geometry expected preserved by refresh')
		assert.isFalse(instance.is_data_changed, 'refresh expected to leave the component clean')

		await teardown(instance)
	});



	it(`update_input_values renders absence as EMPTY and 0 as '0'`, async function() {

		// the unit-level twin of the refresh gate, both directions. 0 is a LEGAL
		// coordinate under the new law, so it must survive the emptiness guard.
		const { instance, node, map_container } = await build_stored_instance('geo_frame_input_values', {id:17, lib_data:point_geometry()})

		const lat_node	= node.querySelector('.geo_active_input.lat')
		const lon_node	= node.querySelector('.geo_active_input.lon')
		const zoom_node	= node.querySelector('.geo_active_input.zoom')

		// absence, in all three flavours the callers actually produce
		assert.isTrue(
			instance.update_input_values(0, {lat:undefined, lon:null, zoom:undefined}, map_container),
			'the call expected to write'
		)
		assert.deepEqual([lat_node.value, lon_node.value, zoom_node.value], ['', '', ''], 'absence expected rendered EMPTY')
		assert.notStrictEqual(instance.current_value[0].lat, '', 'the BUFFER expected to keep the raw absence, not an empty string')

		// 0 is a value, not absence
		instance.update_input_values(0, {lat:0, lon:0, zoom:0}, map_container)
		assert.deepEqual([lat_node.value, lon_node.value, zoom_node.value], ['0', '0', '0'], '0 expected rendered as 0')
		assert.strictEqual(instance.current_value[0].lat, 0, '0 expected kept in the buffer')

		await teardown(instance)
	});



	it(`map_update_coordinates does not borrow the CALLER item id`, async function() {

		// P2-F9: the borrowed entries are the OTHER record stored items and carry
		// its ids. Keeping one made this record save target a foreign id, which
		// applyUpdate (save_component.ts, non-sliced branch) cannot match — it
		// APPENDS, so the record ends up holding two geo items, reloads at the
		// stale first one, and publishes both points.
		const { instance } = await build_stored_instance('geo_frame_observer_id', {id:1, lat:40, lon:-3, zoom:8, alt:null})

		const spy = stub_change_value(instance)

		const caller = {
			data					: { entries : [ { section_tipo: 'test3', section_id: 2 } ] },
			datum					: { data : [ {
				tipo		: 'hierarchy31',
				section_id	: 2,
				entries		: [ { id: 3, lat: 41.5, lon: 2.1, zoom: 12, alt: null } ]
			} ] },
			request_config_object	: {}
		}

		await instance.map_update_coordinates({ caller: caller })

		assert.equal(spy.calls.length, 1, 'expected one change_value call')
		const sent = spy.calls[0].changed_data[0]
		assert.strictEqual(sent.id, 1, 'expected THIS record own item id, recovered from the stored entry')
		assert.notStrictEqual(sent.id, 3, 'the caller item id expected NOT borrowed')
		assert.strictEqual(sent.value.id, 1, 'the sent value expected stamped with this record id')
		assert.equal(sent.value.lat, 41.5, 'the borrowed coordinate expected sent')
		assert.equal(sent.action, 'update', 'expected an update, so the server REPLACES instead of appending')

		spy.restore()
		await teardown(instance)
	});
});



describe(`COMPONENT_GEOLOCATION SEARCH DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_geolocation',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'search',
			view			: 'default',
			id_variant		: 'search_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)

		// insert in search container
		const search_component = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_component',
			parent			: component_container
		})

		node = await instance.render()
		search_component.appendChild(node)

		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.equal(instance.mode, 'search', 'mode expected search')
	});



	it(`search mode data structure`, async function() {

		const data = instance.data || {}
		const entries = data.entries || []

		// search mode may have empty entries or default data
		assert.isOk(Array.isArray(entries), 'entries expected array in search mode')
	});



	it(`destroy search instance`, async function() {

		if (instance) {
			await instance.destroy(true)
		}

		assert.equal(instance.status, 'destroyed', 'status expected destroyed')
		assert.equal(instance.node, null, 'node expected null after destroy')

		// clean DOM
			while (component_container.firstChild) {
				component_container.removeChild(component_container.firstChild)
			}
	});
});



// THE MAP IS NOT BUILT YET
// `ar_layer_loaded` is null until get_map() clones the stored value into it, and
// FeatureGroup[id] only exists once load_layer rendered that layer. The observe
// bridge does not wait for either: a paired component_text_area publishes its tag
// events as soon as its editor loads content, which happens BEFORE the map opens
// whenever this component is not yet activated. Every entry point that is not a
// Leaflet handler must therefore REFUSE, not throw — a throw inside the subscriber
// killed the editor's change handler mid-flight.
describe(`COMPONENT_GEOLOCATION MAP NOT BUILT — the entry points refuse instead of throwing`, function() {

	this.timeout(20000);



	it(`layer_data_change refuses on an unbuilt map and writes nothing`, async function() {

		const instance = await build_empty_instance('unbuilt_tag')

		// the unbuilt shape: get_map() has not run
		assert.isNull(instance.ar_layer_loaded, 'ar_layer_loaded expected null before get_map')

		const spy = stub_change_value(instance)

		const inserted = instance.layer_data_change({
			action	: 'insert',
			tag_id	: 7,
			type	: 'geo'
		})
		const removed = instance.layer_data_change({
			action	: 'remove',
			tag_id	: 7,
			type	: 'geo'
		})
		await tick()

		assert.isFalse(inserted, 'insert expected false on an unbuilt map')
		assert.isFalse(removed, 'remove expected false on an unbuilt map')
		assert.equal(spy.calls.length, 0, 'expected NO save: nothing was read, so nothing may be persisted')
		assert.isUndefined(instance.current_value[0], 'current_value expected untouched on an unbuilt map')
		assert.isNotTrue(instance.is_data_changed, 'is_data_changed expected not set by a refused call')

		spy.restore()
		await instance.destroy(true)
	});



	it(`update_draw_data refuses on an unbuilt map and does not mark the component dirty`, async function() {

		const instance = await build_empty_instance('unbuilt_draw')

		const serialised = instance.update_draw_data(instance.active_layer_id)

		assert.isFalse(serialised, 'update_draw_data expected false on an unbuilt map')
		assert.isNotTrue(
			instance.is_data_changed,
			'is_data_changed expected NOT set: a dirty flag with nothing serialised enqueues a changed_data_item built from data never read'
		)
		assert.isUndefined(instance.current_value[0], 'current_value expected untouched')

		await instance.destroy(true)
	});



	it(`update_draw_data refuses when the layer is absent from ar_layer_loaded`, async function() {

		const instance = await build_empty_instance('unbuilt_layer')

		// map built, but this layer was never loaded
		instance.ar_layer_loaded = []

		assert.isFalse(
			instance.update_draw_data(instance.active_layer_id),
			'update_draw_data expected false when the layer is not loaded'
		)
		assert.isNotTrue(instance.is_data_changed, 'is_data_changed expected not set')

		await instance.destroy(true)
	});



	it(`create_point refuses on an unbuilt map`, async function() {

		const instance = await build_empty_instance('unbuilt_point')

		assert.isNull(instance.map, 'map expected null before get_map')

		assert.isFalse(
			instance.create_point({ lat: 41.7665, lng: -2.4790 }),
			'create_point expected false on an unbuilt map'
		)
		assert.isNotTrue(instance.is_data_changed, 'is_data_changed expected not set')

		await instance.destroy(true)
	});



	it(`a geo-tag insert never writes db_data.value (the phantom key)`, async function() {

		// REGRESSION GATE. The insert branch used to sync `db_data.value[key]` in a
		// floating `.then()`. Component data carries `entries`, never `value`, so it
		// threw `Cannot set properties of undefined` on EVERY tag insertion — inside
		// an unhandled rejection, which is why the suite stayed green. save() owns
		// the baseline (component_common advances db_data from the SERVER's answer),
		// so nothing here may touch it.
		const instance	= await build_empty_instance('no_phantom_key')
		const node		= await instance.render()
		component_container.appendChild(node)

		const map_holder = create_map_holder(component_container, 0)
		await instance.get_map(map_holder, 0)

		instance.ar_layer_loaded	= []
		instance.layer_control		= instance.layer_control || L.control.layers({}).addTo(instance.map)

		const db_data_before = instance.db_data

		const spy = stub_change_value(instance)

		instance.layer_data_change({
			action	: 'insert',
			tag_id	: 7,
			type	: 'geo'
		})
		await tick()

		assert.equal(spy.calls.length, 1, 'expected the insert to reach change_value')
		assert.strictEqual(instance.db_data, db_data_before, 'db_data expected untouched by layer_data_change')
		assert.isUndefined(
			instance.db_data?.value,
			'db_data.value expected undefined — the component data key is `entries`, never `value`'
		)

		spy.restore()
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	});
});


// THE MAP DEFINITION (sources / legend) IS NEVER DROPPED, BORROWED OR LEFT UN-NUMBERED
// WC-2026-11-06-geolocation-map-sources-legend. The server REPLACES the entry on a save,
// so a buffer that was built without `sources`/`legend` deletes them, and one that
// carried another record's would store it. One case per path that writes into
// current_value, then the save-echo learning:
//   handle_coord_change · update_input_values · update_draw_data · layer_data_change
//   (insert and remove) · map_update_coordinates · fn_refresh · save().
describe(`COMPONENT_GEOLOCATION MAP DEFINITION IS PRESERVED`, function() {

	this.timeout(20000);

	/** The stored entry: view, one drawn layer, one numbered source, a legend. */
	const stored_entry = () => ({
		id			: 5,
		lat			: 41.38,
		lon			: 2.17,
		zoom		: 12,
		alt			: 16,
		lib_data	: [{
			layer_id	: 1,
			layer_data	: { type:'FeatureCollection', features:[{
				type		: 'Feature',
				properties	: { layer_id : 1 },
				geometry	: { type:'Point', coordinates:[2.17, 41.38] }
			}]},
			user_layer_name : 'layer_1'
		}],
		sources		: [{
			id			: 2,
			type		: 'xyz',
			url			: 'https://tiles.example.org/{z}/{x}/{y}.png',
			params		: { max_zoom : 18 },
			attribution	: 'Example Org'
		}],
		legend		: { title : 'Roman roads', groups : [{ name : 'Surface', symbols : [{ label : 'Paved' }] }] }
	})

	/** A foreign record's entry: its OWN sources (same small number, other address) and legend. */
	const foreign_entry = () => ({
		id			: 9,
		lat			: 40.1,
		lon			: -3.7,
		zoom		: 9,
		alt			: 0,
		sources		: [{
			id			: 2,
			type		: 'xyz',
			url			: 'https://FOREIGN.example.org/{z}/{x}/{y}.png?key=TOKEN',
			params		: {},
			attribution	: 'Foreign'
		}],
		legend		: { title : 'FOREIGN legend', groups : [] }
	})

	/**
	* Builds a rendered instance whose STORED entry is `entry`, WITHOUT building the map.
	* The node is not attached to the page unless asked: an attached node can trigger the
	* component's own lazy map build mid-test, which seeds the buffer and hides the first touch.
	*/
	const build_unmapped_instance = async function(id_variant, entry, attach=false) {

		const instance = await build_empty_instance(id_variant)
		instance.data.entries	= entry ? [entry] : []
		instance.db_data		= JSON.parse(JSON.stringify(instance.data))

		const node = await instance.render()
		if (attach) {
			component_container.appendChild(node)
		}

		// the precondition of every first-touch case: nothing has seeded the buffer yet
		instance.current_value = []

		return { instance, node, map_container : node.content_data[0].map_container }
	}

	/** Same, with a live map; the buffer is then emptied again to exercise the first touch. */
	const build_mapped_stored_instance = async function(id_variant, entry) {

		const built = await build_unmapped_instance(id_variant, entry, true)
		await built.instance.get_map(built.map_container, 0)
		assert.isOk(built.instance.map, 'Leaflet map expected')
		assert.deepEqual(built.instance.current_value[0], entry, 'get_map expected to seed the buffer from the stored entry')
		built.instance.current_value = []

		return built
	}

	const teardown = async function(instance) {
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	}

	/** The buffer holds the WHOLE stored entry: nothing the save would replace was left out. */
	const assert_whole_entry = function(instance, expected, where) {
		const buffer = instance.current_value[0]
		assert.isOk(buffer, `${where}: current_value[0] expected`)
		assert.deepEqual(buffer.sources, expected.sources, `${where}: sources expected kept`)
		assert.deepEqual(buffer.legend, expected.legend, `${where}: legend expected kept`)
		assert.deepEqual(buffer.lib_data, expected.lib_data, `${where}: the drawn layers expected kept`)
		assert.strictEqual(buffer.zoom, expected.zoom, `${where}: the rest of the view expected kept`)
		// the buffer is a CLONE: editing it never rewrites the baseline the guards compare against
		assert.notStrictEqual(buffer.sources, instance.data.entries[0].sources, `${where}: sources expected cloned`)
		assert.notStrictEqual(buffer.legend, instance.data.entries[0].legend, `${where}: legend expected cloned`)
	}



	it(`get_entry_buffer seeds from the stored entry (a clone) and from {} on an empty record`, async function() {

		const stored = stored_entry()
		const { instance } = await build_unmapped_instance('map_def_buffer', stored)

		const buffer = instance.get_entry_buffer(0)
		assert.deepEqual(buffer, stored, 'the buffer expected equal to the stored entry')
		assert.notStrictEqual(buffer, instance.data.entries[0], 'the buffer expected a clone')
		assert.strictEqual(instance.get_entry_buffer(0), buffer, 'a second call expected to return the SAME live buffer')
		await teardown(instance)

		const { instance : empty } = await build_unmapped_instance('map_def_buffer_empty', null)
		assert.deepEqual(empty.get_entry_buffer(0), {}, 'a record that stores nothing expected to start from {}')
		await teardown(empty)
	});



	it(`handle_coord_change before the map exists keeps the stored sources, legend and layers`, async function() {

		const stored = stored_entry()
		const { instance } = await build_unmapped_instance('map_def_coord', stored)

		instance.handle_coord_change(0, 'lat', 40.5)

		assert.strictEqual(instance.current_value[0].lat, 40.5, 'the typed value expected written')
		assert.strictEqual(instance.current_value[0].lon, stored.lon, 'the other half of the view expected kept')
		assert_whole_entry(instance, stored, 'handle_coord_change')
		assert.strictEqual(instance.data.entries[0].lat, stored.lat, 'the stored entry expected untouched')

		const item = instance.build_changed_data_item(0)
		assert.deepEqual(item.value.sources, stored.sources, 'the SENT value expected to carry the sources')
		assert.strictEqual(item.id, stored.id, 'the SENT item expected to target the stored id')

		await teardown(instance)
	});



	it(`update_input_values (a pan or zoom) before the map exists keeps the stored sources, legend and layers`, async function() {

		const stored = stored_entry()
		const { instance, map_container } = await build_unmapped_instance('map_def_view', stored)

		instance.update_input_values(0, {lat:41.5, lon:2.2, zoom:13}, map_container)

		assert.strictEqual(instance.current_value[0].zoom, 13, 'the view expected written')
		assert_whole_entry(instance, { ...stored, zoom : 13 }, 'update_input_values')

		await teardown(instance)
	});



	it(`drawing (update_draw_data) keeps the stored sources and legend`, async function() {

		const stored = stored_entry()
		const { instance } = await build_mapped_stored_instance('map_def_draw', stored)

		instance.ar_layer_loaded = [{ layer_id : instance.active_layer_id, layer_data : [] }]
		instance.FeatureGroup[instance.active_layer_id] = new L.FeatureGroup().addTo(instance.map)
		instance.create_point({ lat: 41.7665, lng: -2.4790 })

		assert.isOk(instance.current_value[0].lib_data.length > 0, 'the drawn layers expected written')
		assert.deepEqual(instance.current_value[0].sources, stored.sources, 'sources expected kept by a drawing')
		assert.deepEqual(instance.current_value[0].legend, stored.legend, 'legend expected kept by a drawing')
		assert.strictEqual(instance.current_value[0].zoom, stored.zoom, 'the view expected kept by a drawing')

		await teardown(instance)
	});



	it(`geo-tag insert and remove (layer_data_change) keep the stored sources and legend`, async function() {

		const stored = stored_entry()
		const { instance } = await build_mapped_stored_instance('map_def_tag', stored)

		instance.ar_layer_loaded	= []
		instance.layer_control		= instance.layer_control || L.control.layers({}).addTo(instance.map)
		const spy = stub_change_value(instance)

		// insert
		instance.layer_data_change({ action:'insert', tag_id:7, type:'geo' })
		await tick()
		assert.deepEqual(instance.current_value[0].sources, stored.sources, 'sources expected kept by a tag insert')
		assert.deepEqual(instance.current_value[0].legend, stored.legend, 'legend expected kept by a tag insert')
		assert.strictEqual(spy.calls[0].changed_data[0].value.zoom, stored.zoom, 'the SENT value expected whole')

		// remove, from an emptied buffer (a remove can be the first touch too)
		instance.current_value = []
		instance.layer_data_change({ action:'remove', tag_id:7, type:'geo' })
		await tick()
		assert.deepEqual(instance.current_value[0].sources, stored.sources, 'sources expected kept by a tag remove')
		assert.deepEqual(instance.current_value[0].legend, stored.legend, 'legend expected kept by a tag remove')

		spy.restore()
		await teardown(instance)
	});



	it(`map_update_coordinates borrows the VIEW only: the host keeps its own sources and legend, the observed record's never arrive`, async function() {

		const stored = stored_entry()
		const { instance } = await build_mapped_stored_instance('map_def_observer', stored)
		const spy = stub_change_value(instance)

		const caller = {
			data					: { entries : [ { section_tipo: 'test3', section_id: 2 } ] },
			datum					: { data : [ {
				tipo		: 'hierarchy31',
				section_id	: 2,
				entries		: [ foreign_entry() ]
			} ] },
			request_config_object	: {}
		}
		const caller_before = JSON.stringify(caller.datum)

		await instance.map_update_coordinates({ caller : caller })

		const buffer = instance.current_value[0]
		assert.strictEqual(buffer.lat, 40.1, 'the borrowed coordinate expected written')
		assert.strictEqual(buffer.zoom, 9, 'the borrowed zoom expected written')
		assert.deepEqual(buffer.sources, stored.sources, 'THIS record\'s sources expected kept')
		assert.deepEqual(buffer.legend, stored.legend, 'THIS record\'s legend expected kept')
		assert.notInclude(JSON.stringify(buffer), 'FOREIGN', 'nothing of the observed definition expected in the buffer')
		assert.notInclude(JSON.stringify(buffer), 'TOKEN', 'no foreign token expected in the buffer')

		assert.equal(spy.calls.length, 1, 'expected one change_value call')
		const sent = spy.calls[0].changed_data[0].value
		assert.deepEqual(sent.sources, stored.sources, 'the SENT value expected to carry THIS record\'s sources')
		assert.notInclude(JSON.stringify(sent), 'FOREIGN', 'the SENT value expected free of the observed definition')

		assert.equal(JSON.stringify(caller.datum), caller_before, 'the observed record\'s datum expected untouched')

		spy.restore()
		await teardown(instance)
	});



	it(`map_update_coordinates onto a record WITHOUT a definition stores none (the observed one is not copied)`, async function() {

		const { instance } = await build_mapped_stored_instance('map_def_observer_bare', {
			id : 5, lat : 41, lon : 2, zoom : 7, alt : null
		})
		const spy = stub_change_value(instance)

		await instance.map_update_coordinates({ caller : {
			data					: { entries : [ { section_tipo: 'test3', section_id: 2 } ] },
			datum					: { data : [ { tipo : 'hierarchy31', section_id : 2, entries : [ foreign_entry() ] } ] },
			request_config_object	: {}
		} })

		const buffer = instance.current_value[0]
		assert.strictEqual(buffer.lat, 40.1, 'the borrowed coordinate expected written')
		assert.notProperty(buffer, 'sources', 'the observed sources expected NOT copied')
		assert.notProperty(buffer, 'legend', 'the observed legend expected NOT copied')

		spy.restore()
		await teardown(instance)
	});



	it(`the refresh button restores a CLONE of the stored entry, sources and legend included`, async function() {

		const stored = stored_entry()
		const { instance, node } = await build_mapped_stored_instance('map_def_refresh', stored)

		node.querySelector('.map_reload').click()
		await tick()

		assert_whole_entry(instance, stored, 'refresh')
		assert.isNotTrue(instance.is_data_changed, 'refresh expected to leave the component clean')

		// editing the restored buffer must not rewrite the baseline
		instance.current_value[0].sources[0].attribution = 'edited'
		assert.strictEqual(instance.data.entries[0].sources[0].attribution, 'Example Org', 'data.entries expected untouched')
		assert.strictEqual(instance.db_data.entries[0].sources[0].attribution, 'Example Org', 'db_data expected untouched')

		await teardown(instance)
	});



	describe(`save learns what the server owns`, function() {

		/** Replaces component_common.save for one call: the "server" answers with `echo` as the stored entries. */
		const with_saved_echo = async function(instance, echo_entries, api_response, work) {

			const original = component_common.prototype.save
			component_common.prototype.save = async function() {
				if (echo_entries) {
					this.data = { ...this.data, entries : echo_entries }
				}
				return api_response
			}
			try {
				return await work()
			} finally {
				component_common.prototype.save = original
			}
		}

		it(`a confirmed save takes the server's source numbers and normalized legend into the buffer`, async function() {

			const { instance } = await build_unmapped_instance('map_def_learn', null)

			// what the editor holds: a source with no number yet, a legend as typed
			instance.current_value[0] = {
				lat		: 41, lon : 2, zoom : 7, alt : 0,
				sources	: [{ type:'xyz', url:'https://t.example.org/{z}/{x}/{y}', params:{}, attribution:'' }],
				legend	: { title : '  T  ', groups : [] }
			}
			const echo = [{
				id		: 6, lat : 41, lon : 2, zoom : 7, alt : 0,
				sources	: [{ id : 3, type:'xyz', url:'https://t.example.org/{z}/{x}/{y}', params:{}, attribution:'' }],
				legend	: { title : 'T', groups : [] }
			}]

			await with_saved_echo(instance, echo, { ok : true, result : {} }, () => instance.save([{ action:'update', key:0, id:null, value:instance.current_value[0] }]))

			assert.strictEqual(instance.current_value[0].sources[0].id, 3, 'the server-issued source number expected learned')
			assert.strictEqual(instance.current_value[0].legend.title, 'T', 'the normalized legend expected learned')
			assert.strictEqual(instance.current_value[0].zoom, 7, 'the view expected untouched by learning')
			assert.notStrictEqual(instance.current_value[0].sources, echo[0].sources, 'the learned sources expected a clone')

			await teardown(instance)
		});



		it(`an echo without the keys deletes them from the buffer (the save removed them)`, async function() {

			const stored = stored_entry()
			const { instance } = await build_unmapped_instance('map_def_learn_removed', stored)
			instance.current_value[0] = stored_entry()
			delete instance.current_value[0].legend

			const echo = [{ id : 5, lat : 41.38, lon : 2.17, zoom : 12, alt : 16 }]
			await with_saved_echo(instance, echo, { ok : true, result : {} }, () => instance.save([{ action:'update', key:0, id:5, value:{} }]))

			assert.notProperty(instance.current_value[0], 'sources', 'sources expected removed from the buffer')
			assert.notProperty(instance.current_value[0], 'legend', 'legend expected absent')

			await teardown(instance)
		});



		it(`a FAILED save learns nothing: the unsaved edit is not overwritten by the previous model`, async function() {

			const stored = stored_entry()
			const { instance } = await build_unmapped_instance('map_def_learn_failed', stored)
			instance.current_value[0] = stored_entry()
			instance.current_value[0].sources[0].attribution = 'unsaved edit'

			const failure = { ok : false, error : { is_api_error : true, code : 'request.invalid_data', message : 'x' } }
			await with_saved_echo(instance, null, failure, () => instance.save([{ action:'update', key:0, id:5, value:{} }]))
			assert.strictEqual(instance.current_value[0].sources[0].attribution, 'unsaved edit', 'a failed save expected to leave the buffer alone')

			// a skipped save (concurrency guard, no change) answers false: nothing learned either
			await with_saved_echo(instance, null, false, () => instance.save([{ action:'update', key:0, id:5, value:{} }]))
			assert.strictEqual(instance.current_value[0].sources[0].attribution, 'unsaved edit', 'a skipped save expected to leave the buffer alone')

			await teardown(instance)
		});



		it(`learn_saved_map_definition leaves a record with no buffer alone`, async function() {

			const { instance } = await build_unmapped_instance('map_def_learn_nobuffer', stored_entry())

			assert.isFalse(instance.learn_saved_map_definition(0), 'no buffer expected: nothing to learn into')
			assert.isUndefined(instance.current_value[0], 'learning expected not to CREATE a buffer (an untouched record stores nothing)')

			await teardown(instance)
		});
	});
});


// TILES COME FROM THE SERVER, NEVER FROM A PROVIDER
// The component asks the same-origin tile proxy (`<DEDALO_CORE_URL>/api/v1/map_tile`) for every
// tile it can proxy: the built-in OpenStreetMap, the sources stored in the entry and the
// ontology's default sources. A request names a source and never carries an address, which
// is what keeps the page's CSP free of tile hosts and a canvas export of the map untainted
// (same-origin images can be read back). ArcGIS / DARE / Google are not proxied (the core
// relays only providers whose terms allow it) and stay direct.
describe(`COMPONENT_GEOLOCATION TILES GO THROUGH THE TILE PROXY`, function() {

	this.timeout(20000);

	const PROXY_PATH = '/api/v1/map_tile'

	/** A stored entry with two numbered sources and one that was never saved (no id). */
	const entry_with_sources = () => ({
		id			: 5,
		lat			: 41.38,
		lon			: 2.17,
		zoom		: 12,
		alt			: 16,
		lib_data	: [],
		sources		: [
			{ id : 2, type : 'xyz', url : 'https://tiles.example.org/{z}/{x}/{y}.png?key=TOKEN_SECRET', params : { min_zoom : 3, max_zoom : 14 }, attribution : 'Example <b>Org</b>' },
			{ id : 3, type : 'wms', url : 'https://wms.example.org/service', params : { version:'1.3.0', layers:'roads', styles:'', format:'image/png', transparent:true, crs:'EPSG:3857' }, attribution : '' },
			{ type : 'xyz', url : 'https://unsaved.example.org/{z}/{x}/{y}.png', params : {}, attribution : 'never saved' }
		]
	})

	/** Builds an instance on `geo_provider`, with the ontology defaults the server would send, and its map. */
	const build_mapped = async function(id_variant, geo_provider, entry, defaults=[{ id : 'regional', label : 'Regional base', type : 'xyz' }]) {

		const instance = await build_empty_instance(id_variant)
		instance.data.entries	= entry ? [entry] : []
		instance.db_data		= JSON.parse(JSON.stringify(instance.data))
		instance.context.features	= { ...(instance.context.features || {}), geo_provider : geo_provider }
		// what the server sends: id, label, type and what the page needs to draw the layer
		// (attribution, an xyz source's zoom bounds, a wms source's crs) — never an address
		instance.context.properties	= {
			...(instance.context.properties || {}),
			map_sources : defaults
		}

		const node = await instance.render()
		component_container.appendChild(node)
		await instance.get_map(node.content_data[0].map_container, 0)
		assert.isOk(instance.map, 'Leaflet map expected')

		return instance
	}

	const teardown = async function(instance) {
		await instance.destroy(true)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	}

	/** The address Leaflet would request for tile (z=3, x=4, y=2) of `layer`, resolved against the page. */
	const tile_address = (layer) => new URL(layer.getTileUrl({ x : 4, y : 2, z : 3 }), window.location.href)



	it(`get_tile_url names a source and never carries an address; {z}, {x}, {y} stay literal for Leaflet`, async function() {

		const instance = await build_empty_instance('tiles_url')

		const builtin = instance.get_tile_url({ builtin : 'osm' })
		const stored = instance.get_tile_url({ source_id : 7 })
		const named = instance.get_tile_url({ default_id : 'regional' })

		for (const url of [builtin, stored, named]) {
			assert.isTrue(url.startsWith(DEDALO_CORE_URL + PROXY_PATH + '?'), 'expected the proxy under DEDALO_CORE_URL: ' + url)
			assert.notMatch(url, /^[a-z]+:\/\//i, 'expected no scheme: the page asks itself')
			assert.include(url, 'section_tipo=' + encodeURIComponent(instance.section_tipo))
			assert.include(url, 'component_tipo=' + encodeURIComponent(instance.tipo))
			assert.isTrue(url.endsWith('&z={z}&x={x}&y={y}'), 'expected the placeholders literal: ' + url)
		}
		assert.include(builtin, 'builtin=osm')
		assert.notInclude(builtin, 'section_id', 'a built-in expected to name no record')
		assert.include(stored, 'section_id=' + encodeURIComponent(instance.section_id))
		assert.include(stored, 'source_id=7')
		assert.include(named, 'default_id=regional')
		assert.notInclude(named, 'source_id')
	});



	it(`the OSM base layer of every provider that has one comes from the proxy, not from openstreetmap.org`, async function() {

		for (const provider of ['OSM', 'VARIOUS', 'NUMISDATA']) {

			const instance = await build_mapped('tiles_osm_' + provider, provider, null)

			// the OSM layer: tile_layer for OSM, a base layer of the control for the others
			const osm_layers = []
			instance.map.eachLayer(layer => {
				if (layer instanceof L.TileLayer) osm_layers.push(layer)
			})
			assert.isOk(osm_layers.length>0, provider + ': a tile layer expected on the map')
			for (const layer of osm_layers) {
				const address = tile_address(layer)
				assert.strictEqual(address.origin, window.location.origin, provider + ': expected a same-origin tile: ' + address.href)
				assert.strictEqual(address.pathname, DEDALO_CORE_URL + PROXY_PATH)
				assert.strictEqual(address.searchParams.get('builtin'), 'osm')
				// Leaflet fills {z} from the layer's own zoom (the map's), {x} and {y} from the tile
				assert.strictEqual(address.searchParams.get('z'), String(instance.map.getZoom()))
				assert.strictEqual(address.searchParams.get('x'), '4')
				assert.strictEqual(address.searchParams.get('y'), '2')
				assert.notInclude(address.href, 'openstreetmap.org')
			}
			assert.include(osm_layers[0].options.attribution, 'OpenStreetMap', provider + ': the attribution expected shown')

			await teardown(instance)
		}
	});



	it(`stored and default sources are offered as switchable overlays through the proxy — by id, never by address`, async function() {

		const instance = await build_mapped('tiles_sources', 'OSM', entry_with_sources())

		assert.deepEqual(Object.keys(instance.source_layers).sort(), ['default:regional', 'stored:2', 'stored:3'], 'expected the numbered stored sources and the default — not the unsaved one')

		const stored = tile_address(instance.source_layers['stored:2'].layer)
		assert.strictEqual(stored.origin, window.location.origin)
		assert.strictEqual(stored.searchParams.get('source_id'), '2')
		assert.strictEqual(stored.searchParams.get('section_id'), String(instance.section_id))
		assert.strictEqual(tile_address(instance.source_layers['stored:3'].layer).searchParams.get('source_id'), '3', 'a wms source is a tile layer too: the server computes the bbox')
		assert.strictEqual(tile_address(instance.source_layers['default:regional'].layer).searchParams.get('default_id'), 'regional')

		// nothing the page holds about a source's address reaches a tile request
		for (const item of Object.values(instance.source_layers)) {
			const href = tile_address(item.layer).href
			for (const secret of ['tiles.example.org', 'wms.example.org', 'TOKEN_SECRET', 'unsaved.example.org', 'service']) {
				assert.notInclude(href, secret)
			}
		}

		// the xyz source's own zoom bounds: nothing is asked for BELOW its first zoom (minZoom — a
		// minNativeZoom would scale that zoom's tiles down and ask for four times as many per level),
		// and Leaflet scales the last zoom's tiles UP beyond it (maxNativeZoom)
		const options = instance.source_layers['stored:2'].layer.options
		assert.strictEqual(options.minZoom, 3)
		assert.isUndefined(options.minNativeZoom, 'minNativeZoom expected unset: it multiplies the tiles asked for')
		assert.strictEqual(options.maxNativeZoom, 14)

		// the attribution is data: markup in it is escaped before Leaflet's HTML sink
		assert.strictEqual(options.attribution, 'Example &lt;b&gt;Org&lt;/b&gt;')

		// offered, not switched on: opening a map loads no tile from a source nobody asked to see
		for (const item of Object.values(instance.source_layers)) {
			assert.isFalse(instance.map.hasLayer(item.layer), 'a source expected OFF until the viewer switches it on')
		}
		const offered = instance.layer_control._layers.filter(item => item.overlay && item.layer.options.dedalo_source)
		assert.strictEqual(offered.length, 3, 'expected the three sources in the layer control as overlays')

		await teardown(instance)
	});



	it(`an ontology default is drawn with what the server tells the picker: its zoom bounds and its attribution`, async function() {

		const defaults = [
			{ id : 'bounded', label : 'Bounded base', type : 'xyz', attribution : 'Bounded <i>Org</i>', min_zoom : 4, max_zoom : 12 },
			{ id : 'plain', label : 'Plain base', type : 'xyz' }
		]
		const instance = await build_mapped('tiles_default_params', 'OSM', null, defaults)

		const bounded = instance.source_layers['default:bounded'].layer.options
		assert.strictEqual(bounded.minZoom, 4, 'a default xyz source expected to ask for nothing below its first zoom')
		assert.isUndefined(bounded.minNativeZoom)
		assert.strictEqual(bounded.maxNativeZoom, 12, 'and to scale up beyond its last zoom, not be asked for tiles the provider has not')
		assert.strictEqual(bounded.attribution, 'Bounded &lt;i&gt;Org&lt;/i&gt;', 'the licence’s attribution expected shown, escaped before the HTML sink')
		assert.strictEqual(instance.source_layers['default:bounded'].name, 'Bounded base')

		const plain = instance.source_layers['default:plain'].layer.options
		assert.strictEqual(plain.minZoom, 0)
		assert.isUndefined(plain.minNativeZoom)
		assert.strictEqual(plain.maxNativeZoom, 22)
		assert.strictEqual(plain.attribution, '')

		await teardown(instance)
	});



	it(`the layer control never turns a source's name into markup: a hostile default label and a hostile attribution are text`, async function() {

		// The server refuses `<` and `>` in both (save time for a stored source, read time for an ontology
		// default). The page does not rely on it: Leaflet's layer control writes the name as HTML.
		const hostile = '<img src=x onerror="window.dedalo_label_xss=1">'
		window.dedalo_label_xss = 0
		const entry = entry_with_sources()
		entry.sources[0].attribution = hostile
		const defaults = [{ id : 'hostile', label : hostile, type : 'xyz', attribution : '' }]
		const instance = await build_mapped('tiles_label_markup', 'VARIOUS', entry, defaults)
		await tick()

		const container = instance.layer_control.getContainer()
		assert.isNull(container.querySelector('img'), 'a label expected to be text, never an element')
		assert.isNull(container.querySelector('[onerror]'), 'no element with an event handler expected in the control')
		assert.include(container.textContent, hostile, 'expected the label shown as the text it is')
		assert.strictEqual(window.dedalo_label_xss, 0, 'nothing expected to have run')
		// the raw name stays what the data said: only the sink gets the escaped one
		assert.strictEqual(instance.source_layers['default:hostile'].name, hostile)

		await teardown(instance)
	});



	it(`a tile the proxy refused is asked for again, twice at most, and never once it has left the page`, async function() {

		const instance = await build_mapped('tiles_retry', 'OSM', null)
		instance.tile_retry_delays = [5, 5]
		const layer = instance.source_layers['default:regional'].layer

		// an <img> that records every time its src is set; a data URI so nothing leaves the page
		const make_tile = () => {
			const tile = document.createElement('img')
			const state = { value : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', sets : 0 }
			Object.defineProperty(tile, 'src', {
				configurable : true,
				get : () => state.value,
				set : (value) => { state.sets++; state.value = value }
			})
			component_container.appendChild(tile)
			return { tile, state }
		}
		const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

		const kept = make_tile()
		for (let failure = 0; failure<4; failure++) {
			layer.fire('tileerror', { tile : kept.tile, coords : { x : 1, y : 1, z : 3 }, error : new Event('error') })
			await wait(40)
		}
		assert.strictEqual(kept.state.sets, 2, 'expected two retries and then the tile left alone')

		const gone = make_tile()
		layer.fire('tileerror', { tile : gone.tile, coords : { x : 2, y : 1, z : 3 }, error : new Event('error') })
		gone.tile.remove()
		await wait(40)
		assert.strictEqual(gone.state.sets, 0, 'a tile that left the page expected not to be asked for again')

		// the built-in layers retry as well
		const osm = instance.get_osm_layer()
		const builtin = make_tile()
		osm.fire('tileerror', { tile : builtin.tile, coords : { x : 3, y : 1, z : 3 }, error : new Event('error') })
		await wait(40)
		assert.strictEqual(builtin.state.sets, 1)

		await teardown(instance)
	});



	it(`a WMS source in a geographic CRS is not asked for below zoom 8; in the map's own CRS it is asked for at every zoom`, async function() {

		const wms = (id, crs) => ({ id : id, type : 'wms', url : 'https://wms.example.org/service', params : { version:'1.3.0', layers:'roads', styles:'', format:'image/png', transparent:true, crs:crs }, attribution : '' })
		const entry = entry_with_sources()
		entry.sources = [wms(2, 'EPSG:4258'), wms(3, 'EPSG:3857'), wms(4, 'EPSG:4326')]
		const defaults = [
			{ id : 'geographic', label : 'Geographic', type : 'wms', attribution : 'WMS', crs : 'EPSG:4326' },
			{ id : 'mercator', label : 'Mercator', type : 'wms', attribution : 'WMS', crs : 'EPSG:3857' }
		]
		const instance = await build_mapped('tiles_geographic', 'OSM', entry, defaults)

		for (const key of ['stored:2', 'stored:4', 'default:geographic']) {
			assert.strictEqual(instance.source_layers[key].layer.options.minZoom, 8, key + ': a geographic-CRS tile is relayed from zoom 8 up')
		}
		for (const key of ['stored:3', 'default:mercator']) {
			assert.strictEqual(instance.source_layers[key].layer.options.minZoom, 0, key + ': a mercator WMS source expected at every zoom')
		}

		await teardown(instance)
	});



	it(`a source that starts at zoom 8 asks for NO tile at zoom 2 — not the tens of thousands that scaling its zoom-8 tiles down would`, async function() {

		const instance = await build_mapped('tiles_min_zoom', 'OSM', entry_with_sources(), [
			{ id : 'regional', label : 'Regional', type : 'xyz', attribution : '', min_zoom : 8, max_zoom : 14 }
		])
		instance.move_camera(20, 0, 2)
		await tick()

		const layer = instance.source_layers['default:regional'].layer
		layer.addTo(instance.map)
		// a layer built on `minZoom` loads a tile only inside its range: at zoom 2 it is outside
		assert.strictEqual(layer.getContainer().querySelectorAll('img').length, 0, 'no tile expected below the source’s first zoom')
		assert.strictEqual(Object.keys(layer._tiles).length, 0)

		// …and from its first zoom on it asks, as a layer should (the base layer shows the cost of a viewport)
		instance.move_camera(20, 0, 8)
		await tick()
		assert.isAbove(Object.keys(layer._tiles).length, 0, 'tiles expected once the zoom is inside the source’s range')
		assert.isBelow(Object.keys(layer._tiles).length, 200, 'a viewport of tiles expected, never a multiple of it')

		// the layer control greys the checkbox of a source out of its range instead of letting it be switched on
		instance.move_camera(20, 0, 2)
		await tick()
		assert.strictEqual(Object.keys(layer._tiles).length, 0, 'zooming back out expected to release the tiles')

		await teardown(instance)
	});



	it(`a source stays OVER the base map: toggling the theme (which re-adds the OSM base) does not cover it, and the control numbers every base below every source`, async function() {

		const stacking = (layer) => Number(window.getComputedStyle(layer.getContainer()).zIndex)

		// the OSM provider rebuilds its base layer — which is not in the layer control — when the page theme changes.
		// The control numbers the sources 1, 2, 3 … so a base left at Leaflet's default 1 covers the first of them
		const instance = await build_mapped('tiles_stacking', 'OSM', entry_with_sources())
		const first = instance.source_layers['stored:2'].layer
		const second = instance.source_layers['stored:3'].layer
		first.addTo(instance.map)
		second.addTo(instance.map)
		const root = document.documentElement
		const theme_before = root.getAttribute('data-theme')

		const base_before = instance.tile_layer
		root.setAttribute('data-theme', theme_before==='dark' ? 'light' : 'dark')
		await tick()
		await new Promise(resolve => setTimeout(resolve, 20))
		if (theme_before===null) root.removeAttribute('data-theme')
		else root.setAttribute('data-theme', theme_before)

		assert.notStrictEqual(instance.tile_layer, base_before, 'the theme toggle expected to have rebuilt the base layer')
		assert.isTrue(instance.map.hasLayer(first) && instance.map.hasLayer(second), 'the sources expected still on the map')
		for (const source of [first, second]) {
			assert.isAbove(stacking(source), stacking(instance.tile_layer), 'a source expected stacked over the base that was added after it (source ' + stacking(source) + ', base ' + stacking(instance.tile_layer) + ')')
		}
		// …and the first source, which the control numbers 1, is the one a default-numbered base used to cover
		assert.strictEqual(stacking(first), 1)
		assert.strictEqual(stacking(instance.tile_layer), 0)

		await teardown(instance)

		// the bases in the control (VARIOUS, NUMISDATA) are numbered by the control before any source,
		// so a base picked later — Leaflet's control keeps those numbers — is under every source too
		const various = await build_mapped('tiles_stacking_base', 'VARIOUS', entry_with_sources())
		const entries = various.layer_control._layers
		const bases = entries.filter(item => !item.overlay).map(item => item.layer.options.zIndex)
		const sources = entries.filter(item => item.overlay && item.layer.options.dedalo_source).map(item => item.layer.options.zIndex)
		assert.isAbove(bases.length, 0, 'base maps expected in the control')
		assert.isAbove(sources.length, 0, 'sources expected in the control')
		assert.isAbove(Math.min(...sources), Math.max(...bases), 'every source expected numbered above every base map of the control')

		await teardown(various)
	});



	it(`a source overlay is not a drawing layer: it never becomes the active layer and 'full' never switches it on`, async function() {

		const instance = await build_mapped('tiles_hazards', 'VARIOUS', entry_with_sources())
		const source_layer = instance.source_layers['stored:2'].layer

		instance.active_layer_id = 7
		instance.map.fire('overlayadd', { layer : source_layer, name : 'Example' })
		assert.strictEqual(instance.active_layer_id, 7, 'a source switched on expected NOT to take over the active drawing layer')
		// …while a drawing layer still does
		instance.map.fire('overlayadd', { layer : new L.FeatureGroup(), name : 9 })
		assert.strictEqual(instance.active_layer_id, 9, 'a drawing layer expected to become active')

		instance.layers_loader({ load : 'full' })
		for (const item of Object.values(instance.source_layers)) {
			assert.isFalse(instance.map.hasLayer(item.layer), "layers_loader('full') expected to leave tile sources off")
		}

		await teardown(instance)
	});



	it(`the layer control always exists when a layer is loaded: the OSM provider no longer meets \`false.addOverlay\``, async function() {

		// the OSM provider builds no control with its base layer; the map's first drawing layer
		// (loaded when the map is ready) used to call addOverlay on `false`
		const instance = await build_mapped('tiles_control', 'OSM', null, [])
		await tick()

		assert.isOk(instance.layer_control, 'loading the first drawing layer expected to create the control it adds to')
		assert.isOk(instance.FeatureGroup[instance.active_layer_id], 'the drawing layer expected loaded')
		assert.strictEqual(Object.keys(instance.source_layers).length, 0, 'no sources expected to be offered when there are none')

		await teardown(instance)
	});



	it(`build_source_layers is idempotent: a second call replaces the layers, and a stored entry without sources offers only the defaults`, async function() {

		const instance = await build_mapped('tiles_rebuild', 'VARIOUS', entry_with_sources())
		const first = instance.source_layers['stored:2'].layer

		assert.deepEqual(instance.build_source_layers(0).sort(), ['default:regional', 'stored:2', 'stored:3'])
		assert.notStrictEqual(instance.source_layers['stored:2'].layer, first, 'expected a fresh layer')
		const in_control = instance.layer_control._layers.filter(item => item.layer.options.dedalo_source)
		assert.strictEqual(in_control.length, 3, 'expected no duplicate in the control after a rebuild')

		// the saved sources changed (a save echo): the layers follow
		instance.data.entries[0].sources = [instance.data.entries[0].sources[1]]
		assert.deepEqual(instance.build_source_layers(0).sort(), ['default:regional', 'stored:3'])
		assert.strictEqual(instance.layer_control._layers.filter(item => item.layer.options.dedalo_source).length, 2)

		await teardown(instance)
	});



	it(`destroy releases the source layers with the map`, async function() {

		const instance = await build_mapped('tiles_destroy', 'OSM', entry_with_sources())
		assert.isOk(Object.keys(instance.source_layers).length>0)

		await instance.destroy(true)

		assert.deepEqual(instance.source_layers, {}, 'expected the source layers forgotten')
		assert.isNull(instance.map)
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	});
});



// @license-end
