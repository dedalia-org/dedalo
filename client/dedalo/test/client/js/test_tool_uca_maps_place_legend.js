// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, L */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS_PLACE_LEGEND
 * LIVE MAP (tool_uca_maps_fixture.js): place search, geolocation, the scale bar and the legend.
 */

import { create_position_marker, is_geolocate_enabled, toggle_geolocate } from '../../../tools/tool_uca_maps/js/geolocate.js'
import {
	default_element_icon,
	empty_legend,
	MAX_ICON_BYTES
} from '../../../tools/tool_uca_maps/js/legend.js'
import { default_symbol_colour } from '../../../tools/tool_uca_maps/js/legend_symbol.js'
import { focus_place_result, search_places } from '../../../tools/tool_uca_maps/js/place_search.js'
import { clear_legend_message, populate_legend_columns } from '../../../tools/tool_uca_maps/js/render_legend.js'
import { populate_place_search_results } from '../../../tools/tool_uca_maps/js/render_place_search.js'
import { attach_scale_bar, detach_scale_bar } from '../../../tools/tool_uca_maps/js/scale_bar.js'
import { is_toolbar_node } from '../../../tools/tool_uca_maps/js/toolbar.js'
import {
	one_pixel_png,
	pick_file,
	picked_colour,
	resolve_token,
	tick,
	toasts_during,
	tool_sheet,
	until,
	use_live_map,
	with_tool_css
} from './tool_uca_maps_fixture.js'



/**
* The colour of one pixel of a legend icon (a PNG `data:` URL, the only form the record
* keeps), as lowercase #rrggbb, or null where it is transparent. Sample inside a shape:
* its edges are antialiased.
*/
const icon_pixel = async function(icon, x, y) {
	assert.isTrue(icon.startsWith('data:image/png;base64,'), 'expected the icon kept as a PNG data URL')
	const image = new Image()
	image.src = icon
	await image.decode()
	const canvas = Object.assign(document.createElement('canvas'), {width: image.naturalWidth, height: image.naturalHeight})
	const context = canvas.getContext('2d')
	context.drawImage(image, 0, 0)
	const [r, g, b, a] = context.getImageData(x, y, 1, 1).data
	return a<255 ? null : '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** An image file of `width` x `height`, painted one colour, of `type`. */
const painted_file = async function(width, height, colour, type = 'image/png') {
	const canvas = Object.assign(document.createElement('canvas'), {width, height})
	const context = canvas.getContext('2d')
	context.fillStyle = colour
	context.fillRect(0, 0, width, height)
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, type))
	return new File([blob], 'icon', {type})
}



describe('TOOL_UCA_MAPS (live map: place and legend)', function() {

	this.timeout(20000)

	let geolocation, tool
	const {
		stub_tool_request,
		active_group
	} = use_live_map((mounted) => ({geolocation, tool} = mounted))


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

		let fail = null
		stub_tool_request(() => new Promise((resolve, reject) => { fail = reject }))
		await toasts_during(async (toasts) => {
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
		})
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

	it('a refused search leaves its line to core\'s notice and drops the previous hits from the list', async function() {

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

		assert.isTrue(message.hidden, 'expected no panel line beside core\'s notice')
		assert.equal(rows(), 0, 'expected no stale hits under the refusal')
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

	it('a position fix with no FeatureGroup to land in says so and draws nothing', async function() {

		tool.attach_geolocate()

		// the core's 'pm:create' handler would throw adding to a group that does not exist
		geolocation.active_layer_id = 99
		assert.isNotOk(geolocation.FeatureGroup[99], 'expected no group for the active layer')

		const created	= []
		geolocation.map.on('pm:create', (event) => created.push(event.layer))
		await toasts_during((toasts) => {
			const marker = create_position_marker(tool, L.latLng(40.44, -3.70))
			assert.isNull(marker, 'expected no marker')
			assert.equal(created.length, 0, 'expected nothing handed to the draw pipeline')
			assert.equal(toasts.length, 1, 'expected the user told why nothing was drawn')
			assert.equal(toasts[0].message, 'Select a map layer before using geolocation.')
		})
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
	it('a new pin and a new symbol start in the blue of a new map object', async function() {

		const new_object_blue = L.polygon([[39.4, -0.4], [39.5, -0.4], [39.5, -0.3]]).options.color
		tool.attach_legend()
		tool.legend_control.getContainer().click()
		const panel = tool.legend_panel
		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		const icon = tool.legend.groups[0].symbols[0].icon
		assert.equal(await icon_pixel(icon, 18, 21), new_object_blue.toLowerCase(), 'expected the pin in the map\'s blue')
		assert.isNull(await icon_pixel(icon, 18, 13), 'expected the pin\'s hole left clear')

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
		assert.equal(tool.legend.groups.length, 1, 'expected the groups kept')

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

		assert.equal(tool.legend.title, 'Leyenda')
		assert.equal(tool.legend.groups[0].name, 'Periodo')
		assert.equal(tool.legend.groups[0].symbols[0].label, 'xNeolítico')

		assert.deepEqual(tool.delete_legend_column(7), {ok: false})
		assert.deepEqual(tool.delete_legend_element(0, 7), {ok: false})
		assert.deepEqual(tool.set_legend_column_name(7, 'x'), {ok: false})
		assert.deepEqual(tool.add_legend_element(7), {ok: false})
		assert.equal(tool.legend.groups.length, 1, 'expected the legend untouched')

		assert.deepEqual(tool.delete_legend_element(0, 0), {ok: true})
		assert.equal(tool.legend.groups[0].symbols.length, 0)
		assert.deepEqual(tool.delete_legend_column(0), {ok: true})
		assert.equal(tool.legend.groups.length, 0)
	})

	it('an icon must be an allowed type under 2 MB; a good one is kept redrawn as a small PNG', async function() {

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

		// bytes that only claim to be a PNG cannot be redrawn: refused, the pin stays
		const not_an_image = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array([137, 80, 78, 71])], 'fake.png', {type: 'image/png'})
		)
		assert.deepEqual(not_an_image, {ok: false, error: 'The icon could not be read.'})
		assert.equal(tool.legend.groups[0].symbols[0].icon, default_element_icon(), 'expected a refused icon to leave the pin in place')

		// a large JPEG: kept as a PNG that fits 36 px, its proportions kept
		const red = '#c0392b'
		assert.isTrue((await tool.set_legend_element_icon(0, 0, await painted_file(400, 200, red, 'image/jpeg'))).ok)
		const kept = tool.legend.groups[0].symbols[0].icon
		const image = new Image()
		image.src = kept
		await image.decode()
		assert.deepEqual([image.naturalWidth, image.naturalHeight], [36, 18], 'expected it fitted to 36 px, never stretched')
		assert.isAtMost(kept.length, 64 * 1024, 'expected it under the core\'s 64 KiB')
		assert.isNotNull(await icon_pixel(kept, 18, 9), 'expected the picture drawn')

		// a small image is not enlarged; an SVG is redrawn as a PNG too
		assert.isTrue((await tool.set_legend_element_icon(0, 0, await painted_file(10, 12, red))).ok)
		const small = new Image()
		small.src = tool.legend.groups[0].symbols[0].icon
		await small.decode()
		assert.deepEqual([small.naturalWidth, small.naturalHeight], [10, 12], 'expected a small image kept at its size')

		const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#c0392b"/></svg>'], 'a.svg', {type: 'image/svg+xml'})
		assert.isTrue((await tool.set_legend_element_icon(0, 0, svg)).ok, 'expected an SVG accepted')
		assert.equal(await icon_pixel(tool.legend.groups[0].symbols[0].icon, 12, 12), red, 'expected the SVG kept as a PNG of the same picture')
	})

	// the record is the legend's home: the core saves it with the map
	it('every legend edit is written to the component\'s buffer and marks it dirty; nothing saves by itself', async function() {

		let saves = 0
		geolocation.change_value = async () => { saves++; return {ok: true, data: {}} }
		tool.attach_legend()
		assert.notProperty(geolocation.current_value[0] || {}, 'legend', 'expected opening the legend to touch nothing')
		assert.notEqual(geolocation.is_data_changed, true)

		tool.set_legend_title('Roman roads')
		tool.add_legend_column()
		tool.set_legend_column_name(0, 'Surface')
		tool.add_legend_element(0)
		tool.set_legend_element_name(0, 0, 'Paved')
		tool.add_legend_element(0)

		const buffer = geolocation.current_value[0]
		assert.equal(buffer.id, 9001, 'expected the stored entry seeded, so the save keeps the drawing')
		assert.equal(buffer.lib_data.length, 3)
		assert.deepEqual(buffer.legend, {
			title: 'Roman roads', groups: [{name: 'Surface', symbols: [{label: 'Paved', icon: default_element_icon()}]}]
		}, 'expected the record\'s shape; the item without text left out')
		assert.isTrue(geolocation.is_data_changed, 'expected the component dirty')
		assert.equal(geolocation.data.changed_data.length, 1, 'expected the change queued for the component\'s save')
		assert.equal(saves, 0, 'expected no save')

		const message = tool.legend_panel.querySelector('.uca-maps-legend-message')
		assert.equal(message.textContent, 'A group without a name, and an item without text, are not saved.')
		assert.equal(message.dataset.type, 'warning', 'expected a warning: what was typed there is lost on save')
		assert.strictEqual(tool.legend_panel.lastElementChild, message, 'expected the line at the panel\'s foot, below the groups')
		tool.delete_legend_element(0, 1)
		assert.isTrue(message.hidden, 'expected the note gone once everything is saved')

		// "show legend" is a view setting: not written
		const before = JSON.stringify(buffer.legend)
		tool.set_legend_visible(false)
		assert.equal(JSON.stringify(buffer.legend), before)

		// emptied: the key goes
		tool.delete_legend_column(0)
		tool.set_legend_title('')
		assert.notProperty(buffer, 'legend', 'expected an empty legend stored as no key')
	})

	// a legend the core refuses fails the WHOLE geolocation save, drawings included:
	// it is never written, and the panel says why
	it('a legend past the core\'s limits is not written to the buffer, and the panel says why', function() {

		tool.attach_legend()
		const message	= tool.legend_panel.querySelector('.uca-maps-legend-message')
		const buffer	= () => geolocation.current_value[0]

		tool.set_legend_title('Kept')
		tool.add_legend_column()
		tool.set_legend_column_name(0, 'Group')
		tool.add_legend_element(0)
		tool.set_legend_element_name(0, 0, 'Item')
		const refused = (edit, text) => {
			const kept = JSON.stringify(buffer().legend)
			edit()
			assert.equal(message.textContent, text)
			assert.equal(message.dataset.type, 'error')
			assert.equal(JSON.stringify(buffer().legend), kept, 'expected the refused legend NOT written')
		}
		const too_long = 'The legend cannot be saved: at most 16 groups of 64 items, and 200 characters per text.'

		refused(() => tool.set_legend_element_name(0, 0, 'x'.repeat(201)), too_long)
		tool.set_legend_element_name(0, 0, 'x'.repeat(200))
		assert.isTrue(message.hidden, 'expected 200 characters accepted')
		tool.set_legend_element_name(0, 0, 'Item')

		for (let i = 1; i <= 15; i++) {
			tool.add_legend_column()
			tool.set_legend_column_name(i, 'Group ' + i)
		}
		tool.add_legend_column()
		refused(() => tool.set_legend_column_name(16, 'Group 16'), too_long)
		tool.delete_legend_column(16)
		assert.isTrue(message.hidden, 'expected 16 groups accepted')
		assert.equal(buffer().legend.groups.length, 16)
		for (let i = 15; i >= 1; i--) {
			tool.delete_legend_column(i)
		}

		// strip_tags decodes the entity: what is left reads as the start of a tag
		refused(() => tool.set_legend_title('&lt;img src=x'), 'The legend cannot be saved: a text may not hold markup (a < followed by a letter).')
		tool.set_legend_title('Kept')

		// the 256 KiB the icons of one legend share: five icons of 60 000 characters
		const heavy = 'data:image/png;base64,' + 'A'.repeat(60000)
		for (let i = 0; i < 5; i++) {
			tool.add_legend_element(0)
			tool.set_legend_element_name(0, i + 1, 'Heavy ' + i)
			tool.legend.groups[0].symbols[i + 1].icon = heavy
		}
		refused(() => tool.set_legend_title('Kept again'), 'The legend\'s images are too large to save: remove some of them.')
		tool.delete_legend_element(0, 5)
		assert.isTrue(message.hidden, 'expected four of them (240 000 characters) accepted')
		assert.equal(buffer().legend.groups[0].symbols.length, 5)

		// a control character is kept as the core keeps it: a space
		tool.set_legend_title('Two\nlines')
		assert.equal(buffer().legend.title, 'Two lines')
	})

	it('a saved legend opens in the editor and the overlay; an icon that is not a raster data URI is never drawn', function() {

		const png = default_element_icon()
		// get_map seeded the buffer from the stored entry: both carry it, as on a real load
		const saved = {
			title	: 'Saved',
			groups	: [{name: 'Group', symbols: [
				{label: 'With icon', icon: png},
				{label: 'Without'},
				{label: 'Hostile', icon: 'data:image/svg+xml;base64,PHN2Zy8+'},
				{label: 'Address', icon: 'https://example.org/a.png'}
			]}]
		}
		geolocation.data.entries[0].legend = saved
		if (geolocation.current_value[0]) {
			geolocation.current_value[0].legend = structuredClone(saved)
		}
		const dirty_before = geolocation.is_data_changed

		tool.attach_legend()

		assert.equal(tool.legend.title, 'Saved')
		assert.deepEqual(tool.legend.groups[0].symbols.map((element) => [element.label, element.icon]), [
			['With icon', png], ['Without', null], ['Hostile', null], ['Address', null]
		])
		const images = Array.from(tool.legend_overlay.getContainer().querySelectorAll('.uca-maps-legend-overlay-element img'))
		assert.equal(images.length, 4)
		assert.equal(images[0].getAttribute('src'), png)
		for (const image of images.slice(1)) {
			assert.isNull(image.getAttribute('src'), 'expected no src for an item without a raster icon')
			assert.isTrue(image.hidden)
		}
		assert.equal(geolocation.is_data_changed, dirty_before, 'expected opening a saved legend to change nothing')
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

		// v6's cap is inclusive: a file of exactly 2 MB passes the size check (its bytes
		// are no image, so whatever it answers is not the size refusal)
		const at_cap = new File([new Uint8Array(MAX_ICON_BYTES)], 'cap.png', {type: 'image/png'})
		const by_cap = await tool.set_legend_element_icon(0, 0, at_cap)
		assert.notEqual(by_cap.error, by_size.error, 'expected a file of exactly the cap not refused for its size')

		assert.equal(tool.legend.groups[0].symbols[0].icon, default_element_icon())
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
		assert.equal(tool.legend.title, 'Simbología', 'expected typing to reach the legend')
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

		assert.equal(tool.legend.groups[0].name, 'Periodo', 'expected the column name in the column')
		assert.equal(tool.legend.groups[0].symbols[0].label, 'Neolítico', 'expected the element name in the element')
		assert.equal(tool.legend.title, '', 'expected the legend title untouched by either input')

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
		// an unnamed group is only noted (it is not saved), never an error
		assert.isTrue(message.hidden || message.dataset.type==='warning', 'expected no error while nothing failed')
		clear_legend_message(panel)

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

		// a file the browser fails to decode
		const original_decode = HTMLImageElement.prototype.decode
		HTMLImageElement.prototype.decode = () => Promise.reject(new DOMException('undecodable', 'EncodingError'))
		try {
			await pick(one_pixel_png('pin.png'), () => !message.hidden)
		} finally {
			HTMLImageElement.prototype.decode = original_decode
		}
		assert.isFalse(message.hidden, 'expected the failed read shown in the panel')
		assert.equal(message.textContent, 'The icon could not be read.')
		assert.equal(row_src(), default_element_icon(), 'expected the pin kept')

		await pick(one_pixel_png('pin.png'), () => row_src()!==default_element_icon())
		assert.isTrue(message.hidden || message.dataset.type==='warning', 'expected the old error cleared by the next pick')
		assert.notEqual(message.textContent, 'The icon could not be read.')
		assert.isTrue(row_src().startsWith('data:image/png;base64,'), 'expected the row repainted with the uploaded icon')
		assert.equal(row_src(), tool.legend.groups[0].symbols[0].icon, 'expected the row to show the stored icon')
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
		assert.equal(tool.legend.groups.length, 0, 'expected an empty group deleted without asking')

		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		const confirm_node = panel.querySelector('.uca-maps-legend-confirm')
		assert.isTrue(confirm_node.hidden, 'expected no question before the click')

		panel.querySelector('.uca-maps-legend-delete-column').click()
		assert.isFalse(confirm_node.hidden, 'expected the question shown')
		assert.equal(tool.legend.groups.length, 1, 'expected nothing deleted yet')
		assert.equal(document.activeElement, confirm_node.querySelector('.uca-maps-legend-confirm-cancel'), 'expected Cancel focused, the safe answer')

		confirm_node.querySelector('.uca-maps-legend-confirm-cancel').click()
		assert.isTrue(confirm_node.hidden, 'expected Cancel to close the question')
		assert.equal(tool.legend.groups[0].symbols.length, 1, 'expected the group and its element kept')

		panel.querySelector('.uca-maps-legend-delete-column').click()
		panel.querySelector('.uca-maps-legend-confirm-delete').click()
		assert.equal(tool.legend.groups.length, 0, 'expected the group deleted on Delete')
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
		assert.deepEqual(tool.legend.groups.map((column) => column.name), ['B', 'A'], 'expected the groups swapped')
		assert.equal(panel.querySelectorAll('.uca-maps-legend-column-name')[0].value, 'B', 'expected the list rebuilt in the new order')
		// B is now first: its ↑ is disabled, so focus lands on its ↓
		assert.equal(document.activeElement, rows()[0].querySelector('.uca-maps-legend-move-down'), 'expected focus kept on the moved group')

		const element_rows = () => panel.querySelectorAll('.uca-maps-legend-column')[0].querySelectorAll('.uca-maps-legend-element-row')
		element_rows()[0].querySelector('.uca-maps-legend-move-down').click()
		assert.deepEqual(tool.legend.groups[0].symbols.map((element) => element.label), ['y', 'x'], 'expected the elements swapped')
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
		const element = tool.legend.groups[0].symbols[0]

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
		assert.equal(await icon_pixel(element.icon, 18, 18), picked_colour(), 'expected an area filled')
		assert.equal(await icon_pixel(element.icon, 4, 18), default_symbol_colour().toLowerCase(), 'expected its border')
		assert.isNull(await icon_pixel(element.icon, 18, 3), 'expected nothing above the rectangle')
		assert.deepEqual(element.symbol, {shape: 'area', fill: picked_colour(), stroke: default_symbol_colour()}, 'expected the values kept to reopen the editor')
		assert.equal(tool.legend_overlay.getContainer().querySelector('.uca-maps-legend-overlay-element img').getAttribute('src'), element.icon, 'expected the overlay to draw it')

		tool.set_legend_element_symbol(0, 0, {shape: 'area', fill: picked_colour().toUpperCase(), stroke: picked_colour()})
		assert.equal(element.symbol.fill, picked_colour(), 'expected the colour stored lowercase')

		tool.set_legend_element_symbol(0, 0, {shape: 'line', fill: picked_colour(), stroke: picked_colour()})
		assert.equal(await icon_pixel(element.icon, 18, 18), picked_colour(), 'expected a line drawn across the middle')
		assert.isNull(await icon_pixel(element.icon, 18, 12), 'expected a line with no fill')

		tool.set_legend_element_symbol(0, 0, {shape: 'point', fill: default_symbol_colour(), stroke: picked_colour()})
		assert.equal(await icon_pixel(element.icon, 18, 18), default_symbol_colour().toLowerCase(), 'expected a point filled at its centre')
		assert.equal(await icon_pixel(element.icon, 27, 18), picked_colour(), 'expected its ring')
		assert.isNull(await icon_pixel(element.icon, 3, 3), 'expected a circle, not a square')

		// the drawn values reopen the editor but are never saved: core refuses an unknown key
		tool.set_legend_column_name(0, 'Surface')
		tool.set_legend_element_name(0, 0, 'Paved')
		assert.deepEqual(geolocation.current_value[0].legend.groups[0].symbols[0], {label: 'Paved', icon: element.icon}, 'expected the saved symbol without its drawn values')

		// an uploaded image replaces the drawn symbol
		const uploaded = await tool.set_legend_element_icon(
			0, 0, one_pixel_png('pin.png')
		)
		assert.isTrue(uploaded.ok)
		assert.notProperty(element, 'symbol', 'expected the symbol dropped once an image replaces it')
	})

	// the panel's `button` rule carries the tool's action hover; the symbol
	// and shape buttons are neutral frames and must not fill in orange under
	// the pointer. A script cannot hover, so the sheet's :hover rules are
	// replayed under a class of the same specificity.
	it('with the tool CSS, the legend\'s symbol and shape buttons keep a neutral hover', async function() {

		await with_tool_css(async () => {
			tool.attach_legend()
			tool.legend_control.getContainer().click()
			const panel = tool.legend_panel
			panel.querySelector('.uca-maps-legend-add-column').click()
			panel.querySelector('.uca-maps-legend-add-element').click()
			const symbol_btn = panel.querySelector('.uca-maps-legend-symbol-button')
			symbol_btn.click()
			const shape_btn	= panel.querySelector('.uca-maps-legend-symbol-shape:not([aria-pressed="true"])')
			const action_btn	= panel.querySelector('.uca-maps-legend-add-column')
			const secondary_btn	= panel.querySelector('.uca-maps-legend-delete-element')
			assert.isOk(shape_btn, 'expected an unpressed shape button')
			assert.isOk(secondary_btn, 'expected a secondary button (the row\'s ✕)')

			const sheet = tool_sheet()
			const hover_rules = [...sheet.cssRules]
				.filter((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(':hover'))
				.map((rule) => rule.cssText.replace(/:hover/g, '.uca-test-hover'))
			assert.isAbove(hover_rules.length, 0, 'expected the sheet\'s hover rules')
			const style = document.createElement('style')
			// core buttons ease their background: read mid-transition, the hover is invisible
			style.textContent = hover_rules.join('\n') + '\n.uca-test-hover { transition: none !important; }'
			document.head.appendChild(style)
			try {
				const fill_hover = resolve_token(panel, '--tool_fill_hover')

				// positive control: the replay does reach the action hover
				action_btn.classList.add('uca-test-hover')
				assert.equal(getComputedStyle(action_btn).backgroundColor, fill_hover, 'expected the replayed hover on an action button, or this proves nothing')

				for (const [label, node] of [['symbol', symbol_btn], ['shape', shape_btn]]) {
					node.classList.add('uca-test-hover')
					assert.equal(getComputedStyle(node).backgroundColor, 'rgba(0, 0, 0, 0)', label + ': expected no fill under the pointer')
				}

				// the secondary variant keeps its neutral fill, only dimmed: the tool's hover
				// fill was tuned for the tool ink, not for the inverse ink it carries
				const fill_inverse = resolve_token(panel, '--bg_fill_inverse')
				assert.notEqual(fill_inverse, fill_hover, 'expected the two fills apart, or this proves nothing')
				secondary_btn.classList.add('uca-test-hover')
				assert.equal(getComputedStyle(secondary_btn).backgroundColor, fill_inverse, 'secondary: expected its neutral fill under the pointer')
				assert.include(getComputedStyle(secondary_btn).filter, 'brightness', 'secondary: expected the hover shown by dimming')
			} finally {
				style.remove()
				for (const node of [action_btn, symbol_btn, shape_btn, secondary_btn]) node.classList.remove('uca-test-hover')
			}
		})
	})

	it('the symbol opens its own editor, and each gesture repaints the row in place', async function() {

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
		const element = tool.legend.groups[0].symbols[0]
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
		assert.equal(await icon_pixel(row_icon.getAttribute('src'), 18, 18), picked_colour())

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
})


// @license-end
