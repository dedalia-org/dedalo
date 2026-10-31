// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals, DD_TIPOS */
/*eslint no-undef: "error"*/
'use strict';

import {get_instance, delete_instance} from '../../../core/common/js/instances.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {ui} from '../../../core/common/js/ui.js'
import {clone, pause} from '../../../core/common/js/utils/util.js'
import {response_data} from '../../../core/common/js/api_error.js'
import {get_buttons_by_permissions} from '../../../core/component_portal/js/render_edit_component_portal.js'



// component_portal configuration
	const portal_model		= 'component_portal'
	const portal_tipo		= 'test80'
	const portal_section	= 'test3'
	const portal_section_id	= 2
	const portal_lang		= page_globals?.dedalo_data_nolan ?? 'lg-nolan'

// modes and views to test
	const ar_modes		= ['edit', 'list', 'search']
	const ar_views_edit	= ['default', 'line', 'text', 'mosaic', 'tree', 'indexation', 'content']
	const ar_views_list	= ['default', 'line', 'mini', 'text']

// DOM container
	const container = document.getElementById('content')
	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



/**
* GET_PORTAL_INSTANCE
* Creates, builds and returns a component_portal instance
* @param {string} mode - Component mode (edit|list|search)
* @param {string} view - Component view (default|line|text|mosaic|tree|indexation|content|mini)
* @param {number|string} section_id - Section ID
* @return {Promise<component_portal>} Built instance
*/
async function get_portal_instance(mode, view, section_id) {

	const options = {
		model			: portal_model,
		tipo			: portal_tipo,
		section_tipo	: portal_section,
		section_id		: section_id ?? portal_section_id,
		mode			: mode,
		view			: view,
		lang			: portal_lang,
		id_variant		: mode + '_' + view + '_' + Math.random()
	}

	const instance = await get_instance(options)
	await instance.build(true)

	return instance
}//end get_portal_instance



/**
* MAKE_LOCATOR
* Creates a locator object for portal data operations
* @param {number|string} section_id - Target section ID
* @param {string} section_tipo - Target section tipo
* @return {object} Locator object
*/
function make_locator(section_id, section_tipo) {

	section_tipo = section_tipo || portal_section

	return {
		section_tipo			: section_tipo,
		section_id				: String(section_id),
		from_component_tipo		: portal_tipo,
		type					: DD_TIPOS?.DEDALO_RELATION_TYPE_LINK ?? 'dd151'
	}
}//end make_locator



/**
* MAKE_INDEX_LOCATOR
* Creates an INDEXATION locator: the shape tool_indexation stores, one per tag
* anchor. Several of these share section_tipo + section_id and differ only in
* tag_id — that is precisely what the indexation view has to collapse.
* @param {number} id - Per-item counter id (what a 'remove' change targets)
* @param {number|string} section_id - Target record id
* @param {number|string} tag_id - Tag anchor id
* @return {object} Locator object
*/
function make_index_locator(id, section_id, tag_id) {

	return {
		id						: id,
		section_tipo			: portal_section,
		section_id				: String(section_id),
		from_component_tipo		: portal_tipo,
		type					: DD_TIPOS?.DEDALO_RELATION_TYPE_INDEX_TIPO ?? 'dd96',
		tag_id					: String(tag_id),
		tag_type				: 'index'
	}
}//end make_index_locator



/**
* BUILT_ROWS
* The built rows of a portal row view (WC-2026-10-30-section-record-row-box): the
* row window keeps EXACTLY the rows as direct `.section_record` children of
* content_data (placeholders beyond the build bound). A descendant query would
* also catch nested records (hover overlays, nested portals).
* @param {HTMLElement} node - The wrapper (render('content') returns it) or the content_data
* @return {NodeList}
*/
function built_rows(node) {

	const content_data = node.content_data || node
	return content_data.querySelectorAll(':scope > .section_record:not(.placeholder)')
}//end built_rows



/**
* CAPTURE_ROW_UNLINK
* Drives the indexation row's unlink to the point of the save and captures the
* payload WITHOUT letting it reach the server: `change_value` is stubbed to record
* `changed_data` and return false, so unlink_record aborts before any write.
*
* Returns the tag chips the confirmation dialog listed and the locator ids it was
* about to remove — the two sides of the contract "what the row shows is what the
* row deletes".
*
* @param {object} instance - The rendered component_portal instance
* @param {HTMLElement} content - Its content_data node
* @param {string} chip_text - A tag chip identifying which row to act on
* @return {Promise<object>} {chips:Array<string>, ids:Array<number>}
*/
async function capture_row_unlink(instance, content, chip_text) {

	// locate the row by one of its chips
	const row = [...built_rows(content)].find(el =>
		[...el.querySelectorAll('.tags.index')].some(chip => chip.textContent===chip_text)
	)
	assert.notEqual(row, undefined, `a row carrying tag ${chip_text} must be rendered`)

	const button_remove = row.querySelector('.button_remove')
	assert.notEqual(button_remove, null, 'the row must carry an unlink control')

	// stub the save and the native confirm; both are restored in the finally block
	let changed_data = null
	const original_change_value	= instance.change_value
	const original_confirm		= window.confirm
	instance.change_value = async function(options) {
		changed_data = options.changed_data
		return false // abort: no request, no refresh, nothing written
	}
	window.confirm = () => true

	try {
		button_remove.click()
		await pause(300)

		const modal	= [...document.querySelectorAll('dd-modal')].pop()
		assert.notEqual(modal, undefined, 'the confirmation dialog must open')

		const chips = [...modal.querySelectorAll('.indexation_delete_tags >.tags')]
			.map(el => el.textContent)

		const button_unlink = modal.querySelector('.footer.content button.remove')
		assert.notEqual(button_unlink, null, 'the dialog must offer the unlink action')
		button_unlink.click()
		await pause(400)

		return {
			chips	: chips,
			ids		: (changed_data || []).map(el => el.id)
		}
	} finally {
		instance.change_value	= original_change_value
		window.confirm			= original_confirm
		document.querySelectorAll('dd-modal').forEach(el => el.remove())
	}
}//end capture_row_unlink



// ─────────────────────────────────────────────
// 1. LIFECYCLE: INIT → BUILD → RENDER → DESTROY
// ─────────────────────────────────────────────

describe(`COMPONENT_PORTAL LIFECYCLE`, async function() {

	this.timeout(30000)



	// ─── INIT ──────────────────────────────────

	describe(`INIT`, function() {

		it(`${portal_model} init in edit mode`, async function() {

			const options = {
				model			: portal_model,
				tipo			: portal_tipo,
				section_tipo	: portal_section,
				section_id		: portal_section_id,
				mode			: 'edit',
				view			: 'default',
				lang			: portal_lang,
				id_variant		: 'init_edit_' + Math.random()
			}

			const instance = await get_instance(options)

			// asserts
			assert.equal(instance.status, 'initialized', 'status must be initialized')
			assert.equal(instance.model, portal_model)
			assert.equal(instance.tipo, portal_tipo)
			assert.equal(instance.section_tipo, portal_section)
			assert.equal(instance.mode, 'edit')
			assert.equal(instance.context, null)
			assert.equal(instance.node, null)
			assert.equal(instance.active, false)
			assert.equal(instance.is_data_changed, false)

			// cleanup
			await instance.destroy(true, true, true)
		})

		it(`${portal_model} init in list mode`, async function() {

			const options = {
				model			: portal_model,
				tipo			: portal_tipo,
				section_tipo	: portal_section,
				section_id		: portal_section_id,
				mode			: 'list',
				view			: 'default',
				lang			: portal_lang,
				id_variant		: 'init_list_' + Math.random()
			}

			const instance = await get_instance(options)

			assert.equal(instance.status, 'initialized')
			assert.equal(instance.mode, 'list')

			await instance.destroy(true, true, true)
		})

		it(`${portal_model} init in search mode`, async function() {

			const options = {
				model			: portal_model,
				tipo			: portal_tipo,
				section_tipo	: portal_section,
				section_id		: portal_section_id,
				mode			: 'search',
				view			: 'default',
				lang			: portal_lang,
				id_variant		: 'init_search_' + Math.random()
			}

			const instance = await get_instance(options)

			assert.equal(instance.status, 'initialized')
			assert.equal(instance.mode, 'search')

			await instance.destroy(true, true, true)
		})
	})//end describe INIT



	// ─── BUILD ──────────────────────────────────

	describe(`BUILD`, function() {

		it(`${portal_model} build with autoload=true`, async function() {

			const instance = await get_portal_instance('edit', 'default')

			// asserts
			assert.equal(instance.status, 'built', 'status must be built')
			assert.notEqual(instance.context, null, 'context must not be null')
			assert.notEqual(instance.data, null, 'data must not be null')
			assert.notEqual(instance.permissions, null, 'permissions must not be null')
			assert.notEqual(instance.rqo, null, 'rqo must not be null')
			assert.notEqual(instance.request_config_object, null, 'request_config_object must not be null')

			// portal-specific
			assert.notEqual(instance.columns_map, null, 'columns_map must not be null')
			assert.equal(instance.autocomplete, null, 'autocomplete must be null on build')
			assert.equal(instance.autocomplete_active, false, 'autocomplete_active must be false on build')

			await instance.destroy(true, true, true)
		})

		it(`${portal_model} build sets portal-specific properties`, async function() {

			const instance = await get_portal_instance('edit', 'default')

			// asserts on portal-specific build properties
			assert.notEqual(instance.columns_map, null, 'columns_map must not be null after build')
			assert.notEqual(instance.rqo, null, 'rqo must not be null after build')
			assert.notEqual(instance.request_config_object, null, 'request_config_object must not be null after build')
			assert.equal(instance.fixed_columns_map, false, 'fixed_columns_map must be false after build')
			assert.ok(
				instance.show_interface && typeof instance.show_interface === 'object',
				'show_interface must be an object after build'
			)
			assert.notEqual(instance.db_data, null, 'db_data must not be null after build')

			await instance.destroy(true, true, true)
		})

		// The server reports the page size it used in data.pagination.limit; a
		// section ddo_map limit can differ from the context request_config one.
		// The paginator divides by rqo.sqo.limit, so it must follow the server.
		it(`${portal_model} rqo.sqo.limit follows data.pagination.limit`, async function() {

			const source = await get_portal_instance('edit', 'default')
			// a page size the context request_config does not declare
			const server_limit = (source.rqo.sqo.limit || 0) + 3

			const data = clone(source.data)
			data.pagination = { total: server_limit * 2, limit: server_limit, offset: 0 }
			const instance = await get_instance({
				model			: portal_model,
				tipo			: portal_tipo,
				section_tipo	: portal_section,
				section_id		: portal_section_id,
				mode			: 'edit',
				view			: 'default',
				lang			: portal_lang,
				id_variant		: 'pagination_limit_' + Math.random(),
				context			: clone(source.context),
				data			: data,
				datum			: clone(source.datum)
			})
			await instance.build(false)

			assert.equal(instance.rqo.sqo.limit, server_limit, 'rqo.sqo.limit must be the server page size')
			assert.equal(instance.paginator.get_limit(), server_limit, 'the paginator must divide by it')

			await instance.destroy(true, true, true)
			await source.destroy(true, true, true)
		})
	})//end describe BUILD



	// ─── RENDER (all modes and views) ────────────

	describe(`RENDER`, function() {

		// Edit mode views
		for (let i = 0; i < ar_views_edit.length; i++) {
			const view = ar_views_edit[i]

			it(`${portal_model} render edit/${view}`, async function() {

				const instance = await get_portal_instance('edit', view)
				const node = await instance.render()

				// asserts
				assert.equal(instance.status, 'rendered', `status must be rendered for edit/${view}`)
				assert.notEqual(node, null, `node must not be null for edit/${view}`)

				if (view==='default' || view==='line' || view==='mosaic' || view==='tree') {
					assert.notEqual(
						node.querySelector('.content_data'),
						null,
						`content_data must exist for edit/${view}`
					)
				}

				await instance.destroy(true, true, true)
			})
		}

		// List mode views
		for (let i = 0; i < ar_views_list.length; i++) {
			const view = ar_views_list[i]

			it(`${portal_model} render list/${view}`, async function() {

				const instance = await get_portal_instance('list', view)
				const node = await instance.render()

				assert.equal(instance.status, 'rendered', `status must be rendered for list/${view}`)
				assert.notEqual(node, null, `node must not be null for list/${view}`)

				await instance.destroy(true, true, true)
			})
		}

		// Search mode
		it(`${portal_model} render search/default`, async function() {

			const instance = await get_portal_instance('search', 'default')
			const node = await instance.render()

			assert.equal(instance.status, 'rendered')
			assert.notEqual(node, null)

			await instance.destroy(true, true, true)
		})
	})//end describe RENDER



	// ─── DESTROY ──────────────────────────────────

	describe(`DESTROY`, function() {

		it(`${portal_model} destroy after full lifecycle`, async function() {

			const instance = await get_portal_instance('edit', 'default')
			await instance.render()

			// destroy
			const destroy_result = await instance.destroy(
				true,  // delete_self
				true,  // delete_dependencies
				true   // remove_dom
			)

			// asserts
			assert.equal(destroy_result.delete_self, true, 'delete_self must be true')
			assert.equal(destroy_result.delete_dependencies, true, 'delete_dependencies must be true')
			assert.equal(instance.status, 'destroyed', 'status must be destroyed')
			assert.deepEqual(instance.ar_instances, [], 'ar_instances must be empty')
			assert.equal(instance.node, null, 'node must be null after destroy')
			assert.deepEqual(instance.events_tokens, [], 'events_tokens must be empty')
		})

		it(`${portal_model} destroy without removing DOM`, async function() {

			const instance = await get_portal_instance('edit', 'default')
			const node = await instance.render()

			const destroy_result = await instance.destroy(
				true,  // delete_self
				true,  // delete_dependencies
				false  // remove_dom = false
			)

			assert.equal(destroy_result.delete_self, true)
			assert.equal(instance.status, 'destroyed')
			// node may still exist in DOM since remove_dom=false
		})
	})//end describe DESTROY

})//end describe COMPONENT_PORTAL LIFECYCLE



// ─────────────────────────────────────────────
// 2. DATA OPERATIONS: ADD / CHANGE / REMOVE
// ─────────────────────────────────────────────

describe(`COMPONENT_PORTAL DATA OPERATIONS`, async function() {

	this.timeout(30000)



	// ─── ADD DATA (link_record) ──────────────────

	describe(`ADD DATA`, function() {

		it(`${portal_model} link_record adds a locator`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// clear data first to ensure clean state
			const changed_data = [Object.freeze({
				action	: 'set_data',
				id		: null,
				value	: null
			})]
			const api_response = await instance.change_value({
				changed_data	: changed_data,
				refresh		: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: api_response
			})

			// verify clean state
			const entries_before = instance.data?.entries?.length ?? 0
			assert.equal(entries_before, 0, 'entries must be 0 after clear')

			// create locator to add
			const locator = make_locator(9001)

			// link_record
			const result = await instance.link_record(locator)

			// asserts
			assert.equal(result, true, 'link_record must return true')

			const entries_after = instance.data?.entries?.length ?? 0
			assert.equal(
				entries_after,
				1,
				`entries count must be 1 after link_record (got: ${entries_after})`
			)

			await instance.destroy(true, true, true)
		})

		it(`${portal_model} link_record rejects duplicate`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// clear data first
			const changed_data = [Object.freeze({
				action	: 'set_data',
				id		: null,
				value	: null
			})]
			const api_response = await instance.change_value({
				changed_data	: changed_data,
				refresh		: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: api_response
			})

			// add a locator first
			const locator = make_locator(9002)
			const add_result = await instance.link_record(locator)
			assert.equal(add_result, true, 'first link_record must succeed')

			// try to add same locator again
			const duplicate_locator = make_locator(9002)
			const result = await instance.link_record(duplicate_locator)

			// asserts - should be rejected
			assert.equal(result, false, 'duplicate link_record must return false')

			await instance.destroy(true, true, true)
		})
	})//end describe ADD DATA



	// ─── ADD NEW ELEMENT ──────────────────────────

	describe(`ADD NEW ELEMENT`, function() {

		it(`${portal_model} add_new_element creates new record`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			const entries_before = instance.data?.entries?.length ?? 0

			// add_new_element
			const result = await instance.add_new_element(portal_section)

			// asserts
			assert.equal(result, true, 'add_new_element must return true')

			const entries_after = instance.data?.entries?.length ?? 0
			assert.equal(
				entries_after,
				entries_before + 1,
				`entries must increase by 1 after add_new_element`
			)

			// created_section_id (WC-081). The server reports the ADDRESS of the
			// record it created; the add button opens that record instead of
			// guessing it from the echoed page (which only ends on the new record
			// when the whole list fits on one page).
			assert.isOk(
				instance.created_section_id,
				'add_new_element must expose the created section_id'
			)
			const created_entry = instance.data.entries.find(el =>
				el.section_tipo===portal_section &&
				String(el.section_id)===String(instance.created_section_id)
			)
			assert.isOk(
				created_entry,
				'the created record must be present in the echoed entries'
			)
			assert.equal(
				String(instance.data.entries[instance.data.entries.length-1].section_id),
				String(instance.created_section_id),
				'the echoed page must END on the created record (last-page echo)'
			)

			await instance.destroy(true, true, true)
		})

		it(`${portal_model} add_new_element resets created_section_id per call`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// first add
			await instance.add_new_element(portal_section)
			const first_created = instance.created_section_id
			assert.isOk(first_created, 'first add_new_element must expose a created section_id')

			// second add. A stale address from the previous call would make the add
			// button re-open the record created before this one.
			await instance.add_new_element(portal_section)
			const second_created = instance.created_section_id
			assert.isOk(second_created, 'second add_new_element must expose a created section_id')
			assert.notEqual(
				String(second_created),
				String(first_created),
				'created_section_id must name the record of THIS call'
			)

			await instance.destroy(true, true, true)
		})
	})//end describe ADD NEW ELEMENT



	// ─── REMOVE DATA (unlink_record) ──────────────

	describe(`REMOVE DATA`, function() {

		it(`${portal_model} unlink_record removes a locator`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// clear data first
			const clear_data = [Object.freeze({
				action	: 'set_data',
				id		: null,
				value	: null
			})]
			const clear_resp = await instance.change_value({
				changed_data	: clear_data,
				refresh		: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: clear_resp
			})

			// add a locator to ensure there's something to remove
			const locator = make_locator(9010)
			const add_result = await instance.link_record(locator)
			assert.equal(add_result, true, 'link_record must succeed before unlink test')

			const entries_before = instance.data?.entries?.length ?? 0
			assert.ok(entries_before > 0, 'must have at least 1 entry before unlink')

			// find the locator we just added
			const current_entries = instance.data.entries
			const target = current_entries.find(el =>
				String(el.section_id) === '9010' && el.section_tipo === portal_section
			)
			assert.notEqual(target, undefined, 'added locator must exist in entries')

			// unlink_record
			const result = await instance.unlink_record(target)

			// asserts
			assert.equal(result, true, 'unlink_record must return true')

			const entries_after = instance.data?.entries?.length ?? 0
			assert.equal(
				entries_after,
				entries_before - 1,
				`entries must decrease by 1 after unlink`
			)

			await instance.destroy(true, true, true)
		})


		it(`${portal_model} unlink_record removes every locator of an array in one save`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// clear data first
			const clear_resp = await instance.change_value({
				changed_data	: [Object.freeze({action:'set_data', id:null, value:null})],
				refresh			: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: clear_resp
			})

			// add four locators: three to remove together, one that must survive
			for (const id of [9020, 9021, 9022, 9023]) {
				const added = await instance.link_record(make_locator(id))
				assert.equal(added, true, `link_record must succeed for ${id}`)
			}

			const entries_before = instance.data?.entries?.length ?? 0
			assert.equal(entries_before, 4, 'must have the 4 seeded entries before unlink')

			// count the saves: the whole point is ONE request for N removals, so a
			// per-locator loop regresses this test even when the end state matches
			let change_value_calls = 0
			const original_change_value = instance.change_value
			instance.change_value = function(options) {
				change_value_calls++
				return original_change_value.call(this, options)
			}

			const targets = instance.data.entries.filter(el =>
				['9020','9021','9022'].includes(String(el.section_id))
			)
			assert.equal(targets.length, 3, 'the 3 target locators must be resolvable')

			const result = await instance.unlink_record(targets)
			instance.change_value = original_change_value

			// asserts
			assert.equal(result, true, 'unlink_record must return true for an array')
			assert.equal(change_value_calls, 1, 'the N removals must travel in ONE save')

			const entries_after = instance.data?.entries ?? []
			assert.equal(
				entries_after.length,
				entries_before - 3,
				'entries must decrease by exactly the number of locators passed'
			)
			assert.equal(
				entries_after.filter(el => ['9020','9021','9022'].includes(String(el.section_id))).length,
				0,
				'every passed locator must be gone'
			)
			assert.equal(
				entries_after.filter(el => String(el.section_id)==='9023').length,
				1,
				'the locator NOT passed must survive untouched'
			)

			await instance.destroy(true, true, true)
		})
	})//end describe REMOVE DATA



	// ─── CHANGE DATA (update_data_value) ──────────

	describe(`CHANGE DATA`, function() {

		it(`${portal_model} update_data_value via change_value`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// clear data first
			const clear_data = [Object.freeze({
				action	: 'set_data',
				id		: null,
				value	: null
			})]
			const clear_resp = await instance.change_value({
				changed_data	: clear_data,
				refresh		: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: clear_resp
			})

			// use change_value with insert action
			const locator = make_locator(9020)
			const changed_data = [Object.freeze({
				action	: 'insert',
				id		: null,
				value	: locator
			})]

			const api_response = await instance.change_value({
				changed_data	: changed_data,
				refresh		: false
			})

			// asserts
			assert.notEqual(api_response, null, 'api_response must not be null')
			assert.notEqual(response_data(api_response), null, 'the api_response payload must not be null')

			await instance.destroy(true, true, true)
		})

		it(`${portal_model} remove data via change_value`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// clear data first
			const clear_data = [Object.freeze({
				action	: 'set_data',
				id		: null,
				value	: null
			})]
			const clear_resp = await instance.change_value({
				changed_data	: clear_data,
				refresh		: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: clear_resp
			})

			// add a locator first
			const locator = make_locator(9030)
			const add_result = await instance.link_record(locator)
			assert.equal(add_result, true, 'link_record must succeed before remove test')

			// find the locator
			const entries = instance.data?.entries || []
			const target = entries.find(el => String(el.section_id) === '9030')
			if (target) {
				// remove using change_value
				const changed_data = [Object.freeze({
					action	: 'remove',
					id		: target.id,
					value	: null
				})]

				const api_response = await instance.change_value({
					changed_data	: changed_data,
					refresh		: false,
					label		: target.section_id,
					remove_dialog	: () => true
				})

				assert.notEqual(api_response, null, 'api_response must not be null on remove')
			}

			await instance.destroy(true, true, true)
		})
	})//end describe CHANGE DATA



	// ─── SORT DATA ──────────────────────────────────

	describe(`SORT DATA`, function() {

		it(`${portal_model} sort_data reorders entries`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			const entries = instance.data?.entries || []
			if (entries.length >= 2) {
				// swap first two entries
				const result = await instance.sort_data({
					value		: entries,
					source_key	: 0,
					target_key	: 1
				})

				assert.notEqual(result, null, 'sort_data result must not be null')
			}

			await instance.destroy(true, true, true)
		})
	})//end describe SORT DATA

})//end describe COMPONENT_PORTAL DATA OPERATIONS



// ─────────────────────────────────────────────
// 3. PORTAL-SPECIFIC METHODS
// ─────────────────────────────────────────────

describe(`COMPONENT_PORTAL SPECIFIC METHODS`, async function() {

	this.timeout(30000)



	// ─── IS_EMPTY ──────────────────────────────────

	describe(`IS_EMPTY`, function() {

		it(`${portal_model} is_empty returns boolean`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const result = instance.is_empty()

			assert.equal(typeof result, 'boolean', 'is_empty must return boolean')
		})

		it(`${portal_model} is_empty true when no entries`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			// Force empty data
			instance.data = { entries: [] }

			const result = instance.is_empty()

			assert.equal(result, true, 'is_empty must return true when entries is empty')
		})
	})//end describe IS_EMPTY



	// ─── GET_SEARCH_VALUE ──────────────────────────

	describe(`GET_SEARCH_VALUE`, function() {

		it(`${portal_model} get_search_value returns array`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const result = instance.get_search_value()

			assert.equal(Array.isArray(result), true, 'get_search_value must return array')
		})
	})//end describe GET_SEARCH_VALUE



	// ─── GET_TOTAL ──────────────────────────────────

	describe(`GET_TOTAL`, function() {

		it(`${portal_model} get_total returns number or null`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const result = await instance.get_total()

			assert.ok(
				typeof result === 'number' || result === null,
				'get_total must return number or null'
			)
		})
	})//end describe GET_TOTAL



	// ─── UPDATE_PAGINATION_VALUES ──────────────────

	describe(`UPDATE_PAGINATION_VALUES`, function() {

		it(`${portal_model} update_pagination_values with 'add' action`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const total_before = instance.total

			instance.update_pagination_values('add')

			// total should have increased by 1 (if it was a number)
			if (typeof total_before === 'number') {
				assert.equal(instance.total, total_before + 1, 'total must increase by 1 on add')
			}

			await instance.destroy(true, true, true)
		})

		it(`${portal_model} update_pagination_values with 'remove' action`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const total_before = instance.total

			instance.update_pagination_values('remove')

			if (typeof total_before === 'number' && total_before > 0) {
				assert.equal(instance.total, total_before - 1, 'total must decrease by 1 on remove')
			}

			await instance.destroy(true, true, true)
		})
	})//end describe UPDATE_PAGINATION_VALUES



	// ─── NAVIGATE ──────────────────────────────────

	describe(`NAVIGATE`, function() {

		it(`${portal_model} navigate with callback`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			let callback_executed = false
			const result = await instance.navigate({
				callback : () => {
					callback_executed = true
					instance.rqo.sqo.offset = 0
				}
			})

			assert.equal(callback_executed, true, 'navigate callback must be executed')
			assert.equal(result, true, 'navigate must return true')

			await instance.destroy(true, true, true)
		})
	})//end describe NAVIGATE



	// ─── FILTER_DATA_BY_TAG_ID ──────────────────────

	describe(`FILTER_DATA_BY_TAG_ID`, function() {

		it(`${portal_model} filter_data_by_tag_id re-renders the filtered content`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// filter_data_by_tag_id requires a tag object
			const tag_options = {
				tag : {
					node_name	: 'indexOut',
					type		: 'indexOut',
					tag_id		: '1',
					state		: 'd',
					label		: '',
					data		: ''
				}
			}

			// No matching tag locator only empties the filtered entries (a missing
			// datum entry falls back to {} in the method): nothing here may throw, so
			// the row-lock / re-render contract is asserted unconditionally.
			// filter_data_by_tag_id is async (it takes the owner row lock BEFORE it
			// replaces self.data): awaited, it has re-rendered the content
			assert.ok(instance.datum, 'the rendered portal holds its datum')
			const rendered = await instance.filter_data_by_tag_id(tag_options)
			assert.notEqual(rendered, false, 'nothing pending in the rows: the row lock is granted')
			assert.equal(instance.active_tag, tag_options, 'active_tag must be the filter options')
			assert.equal(instance.status, 'rendered', 'status must be rendered after the content re-render')

			await instance.destroy(true, true, true)
		})
	})//end describe FILTER_DATA_BY_TAG_ID



	// ─── RESET_FILTER_DATA ──────────────────────────

	describe(`RESET_FILTER_DATA`, function() {

		it(`${portal_model} reset_filter_data resets active_tag`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)
			await instance.render()

			// set an active_tag first
			instance.active_tag = { tag: { tag_id: '1' } }

			// reset_filter_data is async (it takes the owner row lock BEFORE it
			// replaces self.data): awaited, it has re-rendered the content
			// unconditional, as above (a missing datum entry falls back to {})
			assert.ok(instance.datum, 'the rendered portal holds its datum')
			const rendered = await instance.reset_filter_data()
			assert.notEqual(rendered, false, 'nothing pending in the rows: the row lock is granted')
			assert.equal(instance.active_tag, null, 'active_tag must be null after reset')
			assert.equal(instance.status, 'rendered', 'status must be rendered after the content re-render')

			await instance.destroy(true, true, true)
		})
	})//end describe RESET_FILTER_DATA



	// ─── FOCUS_FIRST_INPUT ──────────────────────────

	describe(`FOCUS_FIRST_INPUT`, function() {

		it(`${portal_model} focus_first_input returns true`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const result = instance.focus_first_input()

			assert.equal(result, true, 'focus_first_input must return true')

			await instance.destroy(true, true, true)
		})
	})//end describe FOCUS_FIRST_INPUT



	// ─── RENDER_VIEWS ──────────────────────────────

	describe(`RENDER_VIEWS`, function() {

		it(`${portal_model} has expected render_views defined`, async function() {

			const instance = await get_portal_instance('edit', 'default', portal_section_id)

			const render_views = instance.render_views
			assert.ok(Array.isArray(render_views), 'render_views must be an array')
			assert.ok(render_views.length > 0, 'render_views must not be empty')

			// check expected views exist
			const view_names = render_views.map(v => v.view + '_' + v.mode)
			assert.ok(view_names.includes('default_edit'), 'must include default_edit view')
			assert.ok(view_names.includes('default_list'), 'must include default_list view')
			assert.ok(view_names.includes('line_edit'), 'must include line_edit view')
			assert.ok(view_names.includes('mosaic_edit'), 'must include mosaic_edit view')
			assert.ok(view_names.includes('tree_edit'), 'must include tree_edit view')
			assert.ok(view_names.includes('text_list'), 'must include text_list view')
			assert.ok(view_names.includes('mini_list'), 'must include mini_list view')

			await instance.destroy(true, true, true)
		})
	})//end describe RENDER_VIEWS

})//end describe COMPONENT_PORTAL SPECIFIC METHODS



// ─────────────────────────────────────────────
// 3b. INDEXATION VIEW: a row is a TERM, not a tag
// ─────────────────────────────────────────────

/**
* The indexation view is the only one where a row is not one locator: the stored
* data holds one locator per tag anchor, so N tags on the same target record are N
* locators that collapse into ONE row carrying N chips.
*
* REGRESSION GUARDED (2026-08-02): the de-duplicated list was handed to
* get_section_records under the key `value`, which nothing reads, so it silently
* fell back to the full entries array and painted one row PER TAG — each row then
* showing every chip of the record, i.e. the term repeated N times identically.
*
* CONTRACT GUARDED: what the row displays is what the row's unlink deletes.
*
* These render against synthetic entries assigned to `data` / `datum` — a pure
* client render contract, so no locator is ever written to the DB.
*/
describe(`COMPONENT_PORTAL INDEXATION VIEW`, async function() {

	this.timeout(30000)

	// tags 11,12,13 point at record 1; tag 21 points at record 3
	const index_entries = [
		make_index_locator(1, 1, 11),
		make_index_locator(2, 1, 12),
		make_index_locator(3, 1, 13),
		make_index_locator(4, 3, 21)
	]

	/**
	* Build an indexation portal carrying `entries` and render it.
	* `datum` is populated too because filter_data_by_tag_id restores the FULL data
	* from there before narrowing it to the selected tag.
	* (!) The render must be FULL: a content-level render needs the wrapper's
	* content_data pointer, which only a full render creates.
	*/
	async function get_indexation_instance(entries) {

		const instance = await get_portal_instance('edit', 'indexation', portal_section_id)

		const data = {
			tipo			: portal_tipo,
			section_tipo	: portal_section,
			section_id		: portal_section_id,
			entries			: clone(entries)
		}
		instance.data	= clone(data)
		instance.datum	= { data: [clone(data)], context: [] }

		// the unlink control is gated on the target section's ontology-declared
		// button_delete; seed it so the control renders regardless of how test80's
		// target section is configured (the gate itself is not what these test)
		instance.permissions = 2
		const target_section_ddo = (instance.target_section || [])[0]
		if (target_section_ddo) {
			target_section_ddo.buttons = target_section_ddo.buttons || []
			if (!target_section_ddo.buttons.find(el => el.model==='button_delete')) {
				target_section_ddo.buttons.push({model:'button_delete', permissions:2})
			}
		}

		const wrapper	= await instance.render()
		const content	= wrapper.content_data || wrapper.querySelector('.content_data')
		assert.notEqual(content, null, 'the indexation view must render a content_data node')

		return {instance, content}
	}//end get_indexation_instance

	/** [['11','12','13'], ['21']] — the chip texts of every rendered row, row-sorted. */
	function rows_chips(content) {
		return [...built_rows(content)]
			.map(row => [...row.querySelectorAll('.tags.index')].map(chip => chip.textContent).sort())
			.sort((a,b) => a.length - b.length)
	}


	it(`${portal_model} indexation view renders one row per record, one chip per tag`, async function() {

		const {instance, content} = await get_indexation_instance(index_entries)

		const rows = built_rows(content)

		// 4 locators, 2 distinct target records
		assert.equal(rows.length, 2, 'one row per TARGET RECORD, not one per tag locator')
		assert.deepEqual(
			rows_chips(content),
			[['21'], ['11','12','13']],
			'each row must carry a chip for every tag pointing at its record'
		)

		await instance.destroy(true, true, true)
	})


	it(`${portal_model} indexation view row unlink removes every locator the row shows`, async function() {

		const {instance, content} = await get_indexation_instance(index_entries)

		const captured = await capture_row_unlink(instance, content, '11')

		assert.deepEqual(
			captured.chips,
			['11','12','13'],
			'the confirmation dialog must list the row\'s whole tag set'
		)
		assert.deepEqual(
			captured.ids,
			[1,2,3],
			'the unlink must send every locator of the term — and only those'
		)

		await instance.destroy(true, true, true)
	})


	it(`${portal_model} indexation view row unlink removes ONLY the selected tag when filtered`, async function() {

		const {instance} = await get_indexation_instance(index_entries)

		// select tag 12: filter_data_by_tag_id narrows data.entries and re-renders
		const content = await instance.filter_data_by_tag_id({tag:{tag_id:'12'}})

		assert.equal(
			built_rows(content).length,
			1,
			'the filtered list must show only the record carrying the selected tag'
		)

		const captured = await capture_row_unlink(instance, content, '12')

		assert.deepEqual(captured.chips, ['12'], 'the filtered row shows only the selected tag')
		assert.deepEqual(captured.ids, [2], 'only the selected locator may be removed')

		await instance.destroy(true, true, true)
	})

})//end describe COMPONENT_PORTAL INDEXATION VIEW



// ─────────────────────────────────────────────
// 4. FULL LIFECYCLE: CREATE → ADD → CHANGE → REMOVE → DESTROY
// ─────────────────────────────────────────────

describe(`COMPONENT_PORTAL FULL LIFECYCLE`, async function() {

	this.timeout(60000)

	it(`${portal_model} complete lifecycle: init → build → render → add → change → remove → destroy`, async function() {

		// INIT
			const options = {
				model			: portal_model,
				tipo			: portal_tipo,
				section_tipo	: portal_section,
				section_id		: portal_section_id,
				mode			: 'edit',
				view			: 'default',
				lang			: portal_lang,
				id_variant		: 'full_lifecycle_' + Math.random()
			}
			const instance = await get_instance(options)

			assert.equal(instance.status, 'initialized', 'INIT: status must be initialized')
			assert.equal(instance.model, portal_model, 'INIT: model must match')

		// BUILD
			await instance.build(true)

			assert.equal(instance.status, 'built', 'BUILD: status must be built')
			assert.notEqual(instance.context, null, 'BUILD: context must not be null')
			assert.notEqual(instance.data, null, 'BUILD: data must not be null')

		// RENDER
			const node = await instance.render()

			assert.equal(instance.status, 'rendered', 'RENDER: status must be rendered')
			assert.notEqual(node, null, 'RENDER: node must not be null')

		// clear data first to ensure clean state
			const clear_data = [Object.freeze({
				action	: 'set_data',
				id		: null,
				value	: null
			})]
			const clear_resp = await instance.change_value({
				changed_data	: clear_data,
				refresh		: false
			})
			await instance.refresh({
				build_autoload		: true,
				tmp_api_response	: clear_resp
			})

		// ADD DATA - link_record
			const locator1 = make_locator(9040)
			const add_result = await instance.link_record(locator1)

			assert.equal(add_result, true, 'ADD: link_record must return true')
			const entries_after_add = instance.data?.entries?.length ?? 0
			assert.equal(
				entries_after_add,
				1,
				'ADD: entries must be 1 after first link_record'
			)

		// ADD DATA - add another locator
			const locator2 = make_locator(9041)
			const add_result2 = await instance.link_record(locator2)

			assert.equal(add_result2, true, 'ADD2: link_record must return true')

		// CHANGE DATA - verify is_empty
			const is_empty = instance.is_empty()
			assert.equal(is_empty, false, 'CHANGE: is_empty must be false after adding data')

		// GET_SEARCH_VALUE
			const search_value = instance.get_search_value()
			assert.equal(Array.isArray(search_value), true, 'CHANGE: get_search_value must return array')

		// GET_TOTAL
			const total = await instance.get_total()
			assert.ok(typeof total === 'number' || total === null, 'CHANGE: get_total must return number|null')

		// REMOVE DATA - unlink_record
			const current_entries = instance.data?.entries || []
			const target = current_entries.find(el => String(el.section_id) === '9040')
			if (target) {
				const unlink_result = await instance.unlink_record(target)
				assert.equal(unlink_result, true, 'REMOVE: unlink_record must return true')
			}

		// DESTROY
			const destroy_result = await instance.destroy(true, true, true)

			assert.equal(destroy_result.delete_self, true, 'DESTROY: delete_self must be true')
			assert.equal(instance.status, 'destroyed', 'DESTROY: status must be destroyed')
			assert.equal(instance.node, null, 'DESTROY: node must be null')
			assert.deepEqual(instance.events_tokens, [], 'DESTROY: events_tokens must be empty')
	})



	it(`${portal_model} lifecycle with add_new_element`, async function() {

		// INIT + BUILD
			const instance = await get_portal_instance('edit', 'default', portal_section_id)

		// RENDER
			await instance.render()

			assert.equal(instance.status, 'rendered')

		// ADD NEW ELEMENT (creates new section record and links it)
			const entries_before = instance.data?.entries?.length ?? 0

			const add_result = await instance.add_new_element(portal_section)

			assert.equal(add_result, true, 'add_new_element must return true')

			const entries_after = instance.data?.entries?.length ?? 0
			assert.equal(
				entries_after,
				entries_before + 1,
				'entries must increase by 1 after add_new_element'
			)

		// DESTROY
			await instance.destroy(true, true, true)

			assert.equal(instance.status, 'destroyed')
	})



	it(`${portal_model} lifecycle in search mode`, async function() {

		// INIT + BUILD
			const instance = await get_portal_instance('search', 'default')

		// RENDER
			const node = await instance.render()

			assert.equal(instance.status, 'rendered')
			assert.notEqual(node, null)

		// GET_SEARCH_VALUE
			const search_value = instance.get_search_value()
			assert.equal(Array.isArray(search_value), true)

		// DESTROY
			await instance.destroy(true, true, true)

			assert.equal(instance.status, 'destroyed')
	})



	it(`${portal_model} lifecycle in list mode`, async function() {

		// INIT + BUILD
			const instance = await get_portal_instance('list', 'default')

		// RENDER
			const node = await instance.render()

			assert.equal(instance.status, 'rendered')
			assert.notEqual(node, null)

		// DESTROY
			await instance.destroy(true, true, true)

			assert.equal(instance.status, 'destroyed')
	})

})//end describe COMPONENT_PORTAL FULL LIFECYCLE



/**
* COMPONENT_PORTAL UPDATE EXTERNAL
* The update-external button of an external portal (`source.mode:'external'`):
* - it sends `build_options:{get_data_external:true}` (the v6 spelling
*   `get_dato_external` is not honoured by the server) and the flag is
*   SINGLE-USE — gone once the refresh settles, so a later read of the same rqo
*   does not recompute again;
* - refresh is READ-level, so a read-only portal (permissions 1) still gets the
*   button — and nothing else of the toolbar; print and no-access get none.
* Stub instances: the contract is the client's own (what it sends, what it
*   renders per permission), not a server round trip.
*/
describe(`COMPONENT_PORTAL UPDATE EXTERNAL`, function() {

	const make_stub = (permissions, view='default') => {
		const sent = []
		const self = {
			permissions		: permissions,
			view			: view,
			context			: {view: view, properties: {source: {mode: 'external'}}},
			target_section	: [],
			show_interface	: {
				button_external		: true,
				button_add			: true,
				button_link			: true,
				button_tree			: true,
				button_list			: false,
				tools				: false,
				button_fullscreen	: false
			},
			rqo		: {source: {tipo: portal_tipo}},
			refresh	: async function(options) {
				// capture what the request would carry at send time
				sent.push({
					options			: options,
					build_options	: self.rqo.source.build_options
						? clone(self.rqo.source.build_options)
						: undefined
				})
				return true
			}
		}
		return {self, sent}
	}

	it(`read-only (permissions 1) renders ONLY the update-external button`, function() {
		const {self} = make_stub(1)
		const node = get_buttons_by_permissions(self)
		assert.notEqual(node, null, 'a reader of an external portal must get the refresh button')
		assert.equal(node.querySelectorAll('.button.sync').length, 1)
		assert.equal(node.querySelector('.button.add'), null, 'no add button for a reader')
		assert.equal(node.querySelector('.button.link'), null, 'no link button for a reader')
		assert.equal(node.querySelector('.button.tree'), null, 'no tree button for a reader')
		assert.equal(node.querySelectorAll('.buttons_fold > *').length, 1, 'nothing but the refresh button')
	})

	it(`read-only non-external portal, print view and no access get no toolbar`, function() {
		const non_external = make_stub(1)
		non_external.self.show_interface.button_external = false
		assert.equal(get_buttons_by_permissions(non_external.self), null)
		assert.equal(get_buttons_by_permissions(make_stub(1, 'print').self), null)
		assert.equal(get_buttons_by_permissions(make_stub(0).self), null)
	})

	it(`edit (permissions 2) keeps the full toolbar incl. update-external`, function() {
		const {self} = make_stub(2)
		// the external switch in component_portal.init turns these off for an external portal
		self.show_interface.button_add	= false
		self.show_interface.button_link	= false
		self.show_interface.button_tree	= false
		const node = get_buttons_by_permissions(self)
		assert.notEqual(node, null)
		assert.equal(node.querySelectorAll('.button.sync').length, 1)
	})

	it(`click sends get_data_external once and clears build_options after the refresh`, async function() {
		const {self, sent} = make_stub(1)
		const node = get_buttons_by_permissions(self)
		const button = node.querySelector('.button.sync')

		button.dispatchEvent(new MouseEvent('click', {bubbles: true}))
		await pause(20)

		assert.equal(sent.length, 1, 'one refresh per click')
		assert.deepEqual(sent[0].build_options, {get_data_external: true})
		assert.equal(sent[0].options.build_autoload, true)
		assert.equal('build_options' in self.rqo.source, false, 'the flag is single-use')

		// a later refresh of the same rqo carries no flag
		await self.refresh({build_autoload: true})
		assert.equal(sent[1].build_options, undefined)
	})

	it(`one refresh at a time: a click while one is in flight is ignored, the button is disabled until it settles`, async function() {
		const {self, sent} = make_stub(1)
		// hold the refresh open until the test releases it
		let release = null
		const plain_refresh = self.refresh
		self.refresh = async function(options) {
			await plain_refresh(options)
			await new Promise(resolve => { release = resolve })
			return true
		}
		const node = get_buttons_by_permissions(self)
		const button = node.querySelector('.button.sync')

		button.dispatchEvent(new MouseEvent('click', {bubbles: true}))
		await pause(20)
		assert.equal(sent.length, 1, 'the first click refreshes')
		assert.equal(button.classList.contains('loading'), true, 'in flight: class loading')
		assert.equal(button.getAttribute('aria-disabled'), 'true', 'in flight: aria-disabled')

		button.dispatchEvent(new MouseEvent('click', {bubbles: true}))
		button.dispatchEvent(new MouseEvent('click', {bubbles: true}))
		await pause(20)
		assert.equal(sent.length, 1, 'clicks while in flight must not stack refreshes')

		release()
		await pause(20)
		assert.equal(button.classList.contains('loading'), false, 'settled: loading removed')
		assert.equal(button.hasAttribute('aria-disabled'), false, 'settled: aria-disabled removed')
		assert.equal('build_options' in self.rqo.source, false, 'the flag is single-use')

		// settled: the next click refreshes again
		self.refresh = plain_refresh
		button.dispatchEvent(new MouseEvent('click', {bubbles: true}))
		await pause(20)
		assert.equal(sent.length, 2, 'a click after the refresh settled refreshes again')
	})

})//end describe COMPONENT_PORTAL UPDATE EXTERNAL



// @license-end
