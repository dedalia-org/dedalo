// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, DD_TIPOS */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_CATALOGING
 * Client-side coverage for the hierarchical cataloging tool.
 *
 * The tool's deeper render/open path needs a host section with a configured
 * section_to_cataloging ddo plus a live thesaurus area, none of which is
 * guaranteed in the headless harness. This suite therefore asserts the reliable,
 * fixture-free contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 *
 * USED MARKER (used_state.js). A card's drag handle carries `used` while a term of
 * a catalog hierarchy links the record. It was set at render and only ever ADDED on
 * drop: a term deleted from the tree left the card "used". The second block gates
 * the recalculation with the data_manager stubbed (no record is read or written):
 * a stale `used` is CLEARED from the server's dd1596 answer, a fresh one is SET,
 * the section datum is spliced, the section's `used_keys` (what the row window's
 * decorate reads for a tile built later) follows, and every removal signal
 * (section_deleted from section.delete_section, a save of the link component,
 * window focus) triggers it. The tiles are found as the content_data's own rows
 * mapped through the window's entries (WC-2026-10-30-section-record-row-box):
 * the fixture is a real row DOM + a window-shaped `{size, entry_of}`, never a node
 * registry.
 */

import {ApiError} from '../../../core/common/js/api_error.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {section} from '../../../core/section/js/section.js'
import {tool_cataloging} from '../../../tools/tool_cataloging/js/tool_cataloging.js'
import {
	get_catalog_target_tipos,
	is_used,
	compute_used_keys,
	locator_key,
	mark_used_row,
	refresh_used_state,
	subscribe_used_triggers,
	USED_FOCUS_DEBOUNCE_MS,
	unsubscribe_used_triggers
} from '../../../tools/tool_cataloging/js/used_state.js'



describe('TOOL_CATALOGING CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_cataloging, 'function', 'expected tool_cataloging to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_cataloging()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.type, null, 'expected type null')
		assert.equal(instance.source_lang, null, 'expected source_lang null')
		assert.equal(instance.target_lang, null, 'expected target_lang null')
		assert.equal(instance.langs, null, 'expected langs null')
		assert.equal(instance.caller, null, 'expected caller null')
		assert.equal(instance.section_to_cataloging, null, 'expected section_to_cataloging null')
		assert.equal(instance.area_thesaurus, null, 'expected area_thesaurus null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_cataloging.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_cataloging.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_cataloging.prototype.refresh, 'function', 'expected refresh wired')
		// render mode delegated to render_tool_cataloging
		assert.equal(typeof tool_cataloging.prototype.edit, 'function', 'expected edit wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_cataloging.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_cataloging.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_cataloging.prototype.load_section, 'function', 'expected load_section defined')
		assert.equal(typeof tool_cataloging.prototype.refresh_used_state, 'function', 'expected refresh_used_state defined')
	})

})



describe('TOOL_CATALOGING USED MARKER', function() {

	this.timeout(10000)

	// generic tipos: the records and the catalog section are never read (stubbed)
	const CARD_TIPO		= 'test3'
	const CATALOG_TIPO	= 'zz_catalog_terms'
	const OTHER_TIPO	= 'zz_other_section'

	const inverse_tipo = () => DD_TIPOS.DEDALO_SECTION_INFO_INVERSE_RELATIONS

	// with_stubbed_request — patch the shared data_manager, run fn, always restore
	const with_stubbed_request = async (respond, fn) => {
		const original	= data_manager.request
		const captured	= []
		data_manager.request = async (options) => {
			const body = options?.body ? JSON.parse(JSON.stringify(options.body)) : null
			captured.push(body)
			return respond(body)
		}
		try {
			await fn(captured)
		} finally {
			data_manager.request = original
		}
		return captured
	}

	const inverse_item = (section_id, from_tipos) => ({
		tipo			: inverse_tipo(),
		section_tipo	: CARD_TIPO,
		section_id		: section_id,
		entries			: from_tipos.map((from_section_tipo, i) => ({
			id					: i + 1,
			section_tipo		: CARD_TIPO,
			section_id			: section_id,
			from_section_tipo	: from_section_tipo,
			from_section_id		: String(100 + i)
		}))
	})

	// a tool shaped as the mosaic's row window and refresh_used_state read it:
	// content_data rows (data-index, the tile's own drag column) + {size, entry_of}.
	// `placeholder_at` leaves that index unbuilt (a placeholder holds nothing).
	const make_tool = (rows, datum_items, placeholder_at=null) => {
		const entries		= rows.map(row => ({section_tipo: CARD_TIPO, section_id: row.section_id}))
		const content_data	= document.createElement('div')
		content_data.className = 'content_data'
		rows.forEach((row, i) => {
			const tile = document.createElement('div')
			tile.className = 'section_record' + (i===placeholder_at ? ' placeholder' : '')
			tile.dataset.index = String(i)
			if (i!==placeholder_at) {
				const column = document.createElement('div')
				column.className = 'column column_drag'
				const dragger = document.createElement('div')
				dragger.className = 'dragger' + (row.used ? ' used' : '')
				column.appendChild(dragger)
				tile.appendChild(column)
			}
			content_data.appendChild(tile)
		})
		const record_window = {
			size		: entries.length,
			entry_of	: (i) => entries[i]
		}
		return {
			status			: 'built',
			events_tokens	: [],
			tool_config		: {set_new_thesaurus_value: {tipo: 'zz_link', section_tipo: CATALOG_TIPO}},
			area_thesaurus	: {
				data : [{
					tipo	: 'dd100',
					value	: [
						{type: 'hierarchy', target_section_tipo: CATALOG_TIPO},
						{type: 'typology', target_section_tipo: OTHER_TIPO}
					]
				}]
			},
			section_to_cataloging : {
				tipo			: CARD_TIPO,
				section_tipo	: CARD_TIPO,
				rqo				: {
					source	: {typo: 'source', action: 'search', model: 'section', tipo: CARD_TIPO, section_tipo: CARD_TIPO, mode: 'list'},
					show	: {ddo_map: [
						{tipo: 'zz_col', section_tipo: CARD_TIPO, parent: CARD_TIPO},
						{tipo: inverse_tipo(), section_tipo: CARD_TIPO, parent: CARD_TIPO, mode: 'list'}
					]}
				},
				data			: {entries: entries},
				datum			: {data: datum_items},
				record_windows	: {rows: record_window},
				node			: {content_data: content_data},
				used_keys		: new Set(rows.filter(row => row.used).map(row => locator_key({section_tipo: CARD_TIPO, section_id: row.section_id})))
			}
		}
	}

	// the drag indicator of tile i, in its OWN drag column (null for a placeholder)
	const dragger_of = (tool, i) => tool.section_to_cataloging.node.content_data.children[i].querySelector(':scope > .column_drag .dragger')

	it('is_used / get_catalog_target_tipos read only catalog hierarchies', function() {
		const tool = make_tool([], [])
		const tipos = get_catalog_target_tipos(tool.area_thesaurus)
		assert.deepEqual(tipos, [CATALOG_TIPO], 'only type hierarchy nodes are catalog targets')
		assert.equal(is_used(inverse_item(1, [CATALOG_TIPO]).entries, tipos), true)
		assert.equal(is_used(inverse_item(1, [OTHER_TIPO, CARD_TIPO]).entries, tipos), false)
		assert.equal(is_used([], tipos), false)
		assert.equal(is_used(undefined, tipos), false)
		assert.equal(is_used(inverse_item(1, [CATALOG_TIPO]).entries, []), false, 'no hierarchy loaded: nothing is used')
		assert.deepEqual(get_catalog_target_tipos(null), [])
	})

	it('compute_used_keys reads the page entries against the datum; mark_used_row toggles the tile only', function() {
		const tool = make_tool(
			[{section_id: '9'}, {section_id: 10}, {section_id: '11'}],
			[inverse_item(9, [CATALOG_TIPO]), inverse_item(10, [OTHER_TIPO]), {tipo: 'zz_col', section_tipo: CARD_TIPO, section_id: 11}]
		)
		const keys = compute_used_keys(tool.section_to_cataloging, [CATALOG_TIPO])
		assert.deepEqual([...keys], [locator_key({section_tipo: CARD_TIPO, section_id: 9})], 'only card 9 is used ("9" and 9 are one record)')
		assert.equal(compute_used_keys(tool.section_to_cataloging, []).size, 0, 'no hierarchy loaded: nothing is used')
		assert.equal(compute_used_keys({}, [CATALOG_TIPO]).size, 0, 'no entries: empty set')

		// the tile's OWN drag column only: a nested overlay record without one is untouched
		const tile = tool.section_to_cataloging.node.content_data.children[1]
		const overlay = document.createElement('div')
		overlay.className = 'section_record sr_mosaic_hover'
		const nested = document.createElement('div')
		nested.className = 'dragger'
		overlay.appendChild(nested)
		tile.prepend(overlay)
		mark_used_row(tile, true)
		assert.equal(tile.querySelector(':scope > .column_drag .dragger').classList.contains('used'), true, 'own drag column marked')
		assert.equal(nested.classList.contains('used'), false, 'nested overlay untouched')
		mark_used_row(tile, false)
		assert.equal(tile.querySelector(':scope > .column_drag .dragger').classList.contains('used'), false, 'cleared')
		mark_used_row(null, true) // no throw
	})

	it('a removed term clears a stale used marker; a new link sets it; datum is spliced', async function() {
		// card 9 is marked used (its term was deleted since); card 10 is not (it was linked since)
		const stale = inverse_item(9, [CATALOG_TIPO])
		const tool = make_tool(
			[{section_id: '9', used: true}, {section_id: '10', used: false}],
			[{tipo: 'zz_col', section_tipo: CARD_TIPO, section_id: 9}, stale, inverse_item(10, [])]
		)
		const captured = await with_stubbed_request(() => ({
			ok		: true,
			data	: {context: [], data: [
				{tipo: CARD_TIPO, section_tipo: CARD_TIPO, entries: []},
				inverse_item(9, [OTHER_TIPO]),
				inverse_item(10, [CATALOG_TIPO])
			]}
		}), async () => {
			assert.equal(await refresh_used_state(tool), true, 'refresh applied')
		})

		assert.equal(dragger_of(tool, 0).classList.contains('used'), false, 'card 9: stale used cleared')
		assert.equal(dragger_of(tool, 1).classList.contains('used'), true, 'card 10: used set from server')
		// the Set decorate reads for a tile built later follows the server
		const used_keys = tool.section_to_cataloging.used_keys
		assert.equal(used_keys.has(locator_key({section_tipo: CARD_TIPO, section_id: 9})), false, 'card 9 left used_keys')
		assert.equal(used_keys.has(locator_key({section_tipo: CARD_TIPO, section_id: 10})), true, 'card 10 entered used_keys')

		// one read: dd1596 only, pinned to the two cards, outside session navigation
		assert.equal(captured.length, 1)
		const rqo = captured[0]
		assert.equal(rqo.action, 'read')
		assert.equal(rqo.source.session_save, false, 'never overwrites the user navigation')
		assert.deepEqual(rqo.show.ddo_map.map(el => el.tipo), [inverse_tipo()])
		assert.deepEqual(rqo.sqo.section_tipo, [CARD_TIPO])
		assert.deepEqual(rqo.sqo.filter_by_locators.map(el => String(el.section_id)).sort(), ['10', '9'])
		assert.equal(rqo.sqo.limit, 2)

		// datum: old dd1596 items replaced, other items kept (a re-materialized row reads it)
		const data = tool.section_to_cataloging.datum.data
		const inverse_items = data.filter(el => el.tipo===inverse_tipo())
		assert.equal(inverse_items.length, 2, 'one dd1596 item per card')
		assert.equal(inverse_items.includes(stale), false, 'stale item removed')
		assert.equal(data.some(el => el.tipo==='zz_col'), true, 'other items kept')
		assert.equal(is_used(inverse_items.find(el => String(el.section_id)==='9').entries, [CATALOG_TIPO]), false)
	})

	it('a targeted refresh reads and touches only the requested card', async function() {
		const tool = make_tool(
			[{section_id: '9', used: true}, {section_id: '10', used: true}],
			[]
		)
		const captured = await with_stubbed_request(() => ({
			ok		: true,
			data	: {context: [], data: [inverse_item(10, [])]}
		}), async () => {
			await refresh_used_state(tool, [{section_tipo: CARD_TIPO, section_id: 10}])
		})
		assert.deepEqual(captured[0].sqo.filter_by_locators, [{section_tipo: CARD_TIPO, section_id: '10'}])
		assert.equal(dragger_of(tool, 0).classList.contains('used'), true, 'card 9 untouched')
		assert.equal(dragger_of(tool, 1).classList.contains('used'), false, 'card 10 cleared')
	})

	it('an unbuilt tile (placeholder) is still read; used_keys carries its state to the later build', async function() {
		// card 10 is a placeholder (N > the window bound): no node to toggle, yet its
		// fresh state must reach the tile the window builds later (decorate)
		const tool = make_tool([{section_id: '9'}, {section_id: '10'}], [], 1)
		const captured = await with_stubbed_request(() => ({
			ok		: true,
			data	: {context: [], data: [inverse_item(9, []), inverse_item(10, [CATALOG_TIPO])]}
		}), async () => {
			assert.equal(await refresh_used_state(tool), true)
		})
		assert.deepEqual(captured[0].sqo.filter_by_locators.map(el => String(el.section_id)).sort(), ['10', '9'], 'every entry of the page is read')
		assert.equal(tool.section_to_cataloging.node.content_data.children[1].children.length, 0, 'the placeholder stays a leaf')
		assert.equal(tool.section_to_cataloging.used_keys.has(locator_key({section_tipo: CARD_TIPO, section_id: 10})), true, 'used_keys carries it')
	})

	it('a page change during the read drops the answer (the window was superseded)', async function() {
		const tool = make_tool([{section_id: '9', used: true}], [])
		await with_stubbed_request(() => {
			// the door replaced the window while the read was in flight
			tool.section_to_cataloging.record_windows = {rows: {size: 1, entry_of: () => ({section_tipo: CARD_TIPO, section_id: '77'})}}
			return {ok: true, data: {context: [], data: [inverse_item(9, [])]}}
		}, async () => {
			assert.equal(await refresh_used_state(tool), false, 'superseded: not applied')
		})
		assert.equal(dragger_of(tool, 0).classList.contains('used'), true, 'untouched')
	})

	it('a failed read leaves the marker as it was', async function() {
		const tool = make_tool([{section_id: '9', used: true}], [])
		await with_stubbed_request(() => ({
			ok		: false,
			// data_manager.request answers failures as ApiError instances
			error	: new ApiError({code: 'internal.unexpected', message: 'x', status: 500})
		}), async () => {
			assert.equal(await refresh_used_state(tool), false)
		})
		assert.equal(dragger_of(tool, 0).classList.contains('used'), true)
	})

	it('refreshes are serialized: the later answer is the one applied', async function() {
		const tool = make_tool([{section_id: '9', used: false}], [])
		let call = 0
		await with_stubbed_request(async () => {
			call++
			const mine = call
			// the first answer arrives LAST if the calls were not serialized
			await new Promise(resolve => setTimeout(resolve, mine===1 ? 60 : 0))
			return {ok: true, data: {context: [], data: [inverse_item(9, mine===1 ? [CATALOG_TIPO] : [])]}}
		}, async () => {
			const first		= refresh_used_state(tool, [{section_tipo: CARD_TIPO, section_id: '9'}])
			const second	= refresh_used_state(tool, [{section_tipo: CARD_TIPO, section_id: '9'}])
			await Promise.all([first, second])
		})
		assert.equal(call, 2)
		assert.equal(dragger_of(tool, 0).classList.contains('used'), false, 'the second (newer) answer wins')
	})

	it('removal signals trigger a refresh; unrelated ones do not', async function() {
		const tool = make_tool([], [])
		let refreshes = 0
		tool.refresh_used_state = () => { refreshes++ }
		subscribe_used_triggers(tool)
		try {
			assert.equal(tool.events_tokens.length, 2, 'section_deleted + save tokens on the tool')

			// (a) a catalog term deleted
			event_manager.publish('section_deleted', {section_tipo: CATALOG_TIPO, deleted: [7194]})
			assert.equal(refreshes, 1, 'catalog term delete refreshes')
			event_manager.publish('section_deleted', {section_tipo: OTHER_TIPO, deleted: [1]})
			assert.equal(refreshes, 1, 'unrelated delete ignored')

			// (b) the link component saved in a catalog term
			const link_instance = {tipo: 'zz_link', section_tipo: CATALOG_TIPO}
			event_manager.publish('save', {instance: link_instance})
			assert.equal(refreshes, 2, 'link save (unlink) refreshes')
			event_manager.publish('save', {instance: {tipo: 'zz_other', section_tipo: CATALOG_TIPO}})
			event_manager.publish('save', {instance: {tipo: 'zz_link', section_tipo: OTHER_TIPO}})
			assert.equal(refreshes, 2, 'other components / sections ignored')

			// no skip state: every save of the link refreshes (incl. the drop's own)
			event_manager.publish('save', {instance: link_instance})
			assert.equal(refreshes, 3, 'a second save of the same instance refreshes')

			// (c) back from another window: focus + visibilitychange of ONE tab
			// return are debounced into one refresh
			window.dispatchEvent(new Event('focus'))
			document.dispatchEvent(new Event('visibilitychange'))
			assert.equal(refreshes, 3, 'debounced: nothing yet')
			await new Promise(resolve => setTimeout(resolve, USED_FOCUS_DEBOUNCE_MS + 50))
			assert.equal(refreshes, document.visibilityState==='visible' ? 4 : 3, 'one refresh for the pair')
		} finally {
			for (const token of tool.events_tokens) event_manager.unsubscribe(token)
			unsubscribe_used_triggers(tool)
		}
		const before = refreshes
		window.dispatchEvent(new Event('focus'))
		event_manager.publish('section_deleted', {section_tipo: CATALOG_TIPO, deleted: [1]})
		assert.equal(refreshes, before, 'released: no listener left behind')
		assert.equal(tool.used_focus_handler, null)
	})

	it('section.delete_section publishes section_deleted on success only', async function() {
		const instance = new section()
		instance.model			= 'section'
		instance.type			= 'section'
		instance.tipo			= CATALOG_TIPO
		instance.section_tipo	= CATALOG_TIPO
		instance.section_id		= 7194
		instance.mode			= 'list'
		const published = []
		const token = event_manager.subscribe('section_deleted', (options) => published.push(options))
		try {
			const sqo = {section_tipo: [CATALOG_TIPO], filter_by_locators: [{section_tipo: CATALOG_TIPO, section_id: 7194}], limit: 1}
			await with_stubbed_request(() => ({ok: true, data: [7194]}), async () => {
				assert.equal(await instance.delete_section({sqo, delete_mode: 'delete_record'}), true)
			})
			assert.deepEqual(published, [{section_tipo: CATALOG_TIPO, deleted: [7194], delete_mode: 'delete_record'}])

			await with_stubbed_request(() => ({ok: true, data: []}), async () => {
				assert.equal(await instance.delete_section({sqo, delete_mode: 'delete_record'}), false)
			})
			assert.equal(published.length, 1, 'nothing deleted: nothing published')
		} finally {
			event_manager.unsubscribe(token)
		}
	})

})

// @license-end
