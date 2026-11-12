// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals, DD_TIPOS */
/*eslint no-undef: "error"*/
'use strict';

import {get_instance, delete_instance} from '../../../core/common/js/instances.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {ui} from '../../../core/common/js/ui.js'
import {clone, pause} from '../../../core/common/js/utils/util.js'



// component_relation_index configuration
// Note: client-side component_relation_index is an alias of component_portal
	const model			= 'component_relation_index'
	const tipo			= 'test25'
	const section_tipo	= 'test3'
	const section_id	= 1
	const lang			= page_globals?.dedalo_data_nolan ?? 'lg-nolan'

// modes and views to test
	const ar_modes			= ['edit', 'list', 'search']
	const ar_views_edit		= ['default', 'line', 'indexation']
	const ar_views_list		= ['default', 'line', 'text']

// DOM container
const container = document.getElementById('content')
const component_container = ui.create_dom_element({
	element_type	: 'div',
	class_name		: 'component_container',
	parent			: container
})



/**
* GET_RELATION_INDEX_INSTANCE
* Creates, builds and returns a component_relation_index instance
* @param {string} mode - Component mode (edit|list|search)
* @param {string} view - Component view (default|line|text|indexation)
* @param {number|string} sid - Section ID
* @return {Promise<component_relation_index>} Built instance
*/
async function get_relation_index_instance(mode, view, sid) {

	const options = {
		model			: model,
		tipo			: tipo,
		section_tipo	: section_tipo,
		section_id		: sid ?? section_id,
		mode			: mode,
		view			: view,
		lang			: lang,
		id_variant		: mode + '_' + view + '_' + Math.random()
	}

	const instance = await get_instance(options)
	await instance.build(true)

	return instance
}//end get_relation_index_instance



// ─────────────────────────────────────────────
// 1. LIFECYCLE: INIT → BUILD → RENDER → DESTROY
// ─────────────────────────────────────────────

describe(`COMPONENT_RELATION_INDEX LIFECYCLE`, async function() {

	this.timeout(30000)



	// ─── INIT ──────────────────────────────────

	describe(`INIT`, function() {

		it(`${model} init in edit mode`, async function() {

			const options = {
				model			: model,
				tipo			: tipo,
				section_tipo	: section_tipo,
				section_id		: section_id,
				mode			: 'edit',
				view			: 'default',
				lang			: lang,
				id_variant		: 'init_edit_' + Math.random()
			}

			const instance = await get_instance(options)

			// asserts
			assert.equal(instance.status, 'initialized', 'status must be initialized')
			assert.equal(instance.model, model)
			assert.equal(instance.tipo, tipo)
			assert.equal(instance.section_tipo, section_tipo)
			assert.equal(instance.mode, 'edit')
			assert.equal(instance.context, null)
			assert.equal(instance.node, null)
			assert.equal(instance.active, false)
			assert.equal(instance.is_data_changed, false)

			// cleanup
			await instance.destroy(true, true, true)
		})

		it(`${model} init in list mode`, async function() {

			const options = {
				model			: model,
				tipo			: tipo,
				section_tipo	: section_tipo,
				section_id		: section_id,
				mode			: 'list',
				view			: 'default',
				lang			: lang,
				id_variant		: 'init_list_' + Math.random()
			}

			const instance = await get_instance(options)

			assert.equal(instance.status, 'initialized')
			assert.equal(instance.mode, 'list')

			await instance.destroy(true, true, true)
		})

		it(`${model} init in search mode`, async function() {

			const options = {
				model			: model,
				tipo			: tipo,
				section_tipo	: section_tipo,
				section_id		: section_id,
				mode			: 'search',
				view			: 'default',
				lang			: lang,
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

		it(`${model} build with autoload=true`, async function() {

			const instance = await get_relation_index_instance('edit', 'default')

			// asserts
			assert.equal(instance.status, 'built', 'status must be built')
			assert.notEqual(instance.context, null, 'context must not be null')
			assert.notEqual(instance.permissions, null, 'permissions must not be null')

			await instance.destroy(true, true, true)
		})
	})//end describe BUILD



	// ─── RENDER (all modes and views) ────────────

	describe(`RENDER`, function() {

		// Edit mode views
		for (let i = 0; i < ar_views_edit.length; i++) {
			const view = ar_views_edit[i]

			it(`${model} render edit/${view}`, async function() {

				const instance = await get_relation_index_instance('edit', view)
				const node = await instance.render()

				// asserts
				assert.equal(instance.status, 'rendered', `status must be rendered for edit/${view}`)
				assert.notEqual(node, null, `node must not be null for edit/${view}`)

				await instance.destroy(true, true, true)
			})
		}

		// List mode views
		for (let i = 0; i < ar_views_list.length; i++) {
			const view = ar_views_list[i]

			it(`${model} render list/${view}`, async function() {

				const instance = await get_relation_index_instance('list', view)
				const node = await instance.render()

				assert.equal(instance.status, 'rendered', `status must be rendered for list/${view}`)
				assert.notEqual(node, null, `node must not be null for list/${view}`)

				await instance.destroy(true, true, true)
			})
		}

		// Search mode
		it(`${model} render search/default`, async function() {

			const instance = await get_relation_index_instance('search', 'default')
			const node = await instance.render()

			assert.equal(instance.status, 'rendered')
			assert.notEqual(node, null)

			await instance.destroy(true, true, true)
		})
	})//end describe RENDER



	// ─── DESTROY ──────────────────────────────────

	describe(`DESTROY`, function() {

		it(`${model} destroy after full lifecycle`, async function() {

			const instance = await get_relation_index_instance('edit', 'default')
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
	})//end describe DESTROY

})//end describe COMPONENT_RELATION_INDEX LIFECYCLE



// ─────────────────────────────────────────────
// 2. DATA OPERATIONS
// ─────────────────────────────────────────────

describe(`COMPONENT_RELATION_INDEX DATA OPERATIONS`, async function() {

	this.timeout(30000)



	// ─── GET DATA ──────────────────────────────────

	describe(`GET DATA`, function() {

		it(`${model} get_data returns entries or null`, async function() {

			const instance = await get_relation_index_instance('edit', 'default')

			// data is resolved externally (inverse locators)
			const data = instance.data
			assert.ok(
				data === null || typeof data === 'object',
				'data must be null or object'
			)

			await instance.destroy(true, true, true)
		})
	})//end describe GET DATA



	// ─── IS_EMPTY ──────────────────────────────────

	describe(`IS_EMPTY`, function() {

		// component_portal.is_empty() takes NO argument: it reads the instance's
		// own `data.entries`. (The former `is_empty(null) → true` case only held
		// while the suite DB had no dd96 pointer — it asserted the corpus, not
		// the method.) The runner's pointer fixture makes test3/1 non-empty.
		it(`${model} is_empty reflects its own entries (the runner's pointer → false; none → true)`, async function() {

			const instance = await get_relation_index_instance('edit', 'default')
			try {
				assert.isAbove((instance.data?.entries || []).length, 0, 'precondition: the dd96 pointer fixture is indexed')
				assert.equal(instance.is_empty(), false, 'an index with an entry is not empty')

				instance.data = { ...instance.data, entries: [] }
				assert.equal(instance.is_empty(), true, 'an index with no entries is empty')
			} finally {
				await instance.destroy(true, true, true)
			}
		})
	})//end describe IS_EMPTY

})//end describe COMPONENT_RELATION_INDEX DATA OPERATIONS



// ─────────────────────────────────────────────
// 3. SEARCH DATA OPERATIONS
// ─────────────────────────────────────────────

describe(`COMPONENT_RELATION_INDEX SEARCH DATA OPERATIONS`, async function() {

	this.timeout(30000)



	describe(`SEARCH MODE`, function() {

		it(`${model} search mode instance builds correctly`, async function() {

			const instance = await get_relation_index_instance('search', 'default')

			assert.equal(instance.mode, 'search', 'mode must be search')
			assert.equal(instance.status, 'built', 'status must be built')

			await instance.destroy(true, true, true)
		})

		it(`${model} search mode renders correctly`, async function() {

			const instance = await get_relation_index_instance('search', 'default')
			const node = await instance.render()

			assert.equal(instance.status, 'rendered', 'status must be rendered')
			assert.notEqual(node, null, 'node must not be null')

			await instance.destroy(true, true, true)
		})
	})//end describe SEARCH MODE

})//end describe COMPONENT_RELATION_INDEX SEARCH DATA OPERATIONS



// ─────────────────────────────────────────────
// 4. COLUMNS FROM THE POINTING SECTION (T0-8)
// ─────────────────────────────────────────────
// test25 is CONFIG-LESS (`source.mode external`, no request_config of its own):
// its columns are the POINTING section's related_list (test3 → relation_list
// test138 → [test52]), merged by the server into its request_config with
// parent = test25. Without the merge `get_columns_map` finds no ddo parented to
// test25 → columns_map [] → every row renders empty.
// SITUATION: the runner installs ONE dd96 pointer (a scratch test3 record whose
// test54 locator indexes test3/1 — src/core/test_data/relation_index_pointer_fixture.ts)
// before its server starts and sweeps it after; the canonical playground holds none.

describe(`COMPONENT_RELATION_INDEX COLUMNS FROM THE POINTING SECTION`, async function() {

	this.timeout(30000)

	// the pointing section's related_list column (test138 → test52)
	const related_list_tipo = 'test52'
	// the pointer's test52 value — relation_index_pointer_fixture.ts
	// SUITE_INDEX_POINTER_LABEL (client_situations_native pins the two equal)
	const pointer_label = 'zz suite relation_index pointer'

	for (const mode of ['edit', 'list']) {

		it(`${model} ${mode}/line: columns from the pointing section's related_list and a rendered cell`, async function() {

			const instance = await get_relation_index_instance(mode, 'line')
			try {
				// precondition: the runner's dd96 pointer is indexed (a missing
				// fixture must not read as a column defect)
				const entries = instance.data?.entries || []
				assert.isAbove(
					entries.length, 0,
					'no dd96 pointer indexes test3/1 — the runner must install relation_index_pointer_fixture'
				)

				// the merged config: a ddo parented to the index itself
				const ddo_map = (instance.context.request_config || [])
					.flatMap(el => el?.show?.ddo_map || [])
					.filter(el => el.parent === tipo)
				assert.isTrue(
					ddo_map.some(el => el.tipo === related_list_tipo && el.section_tipo === section_tipo),
					`request_config show.ddo_map must carry ${related_list_tipo} @ ${section_tipo} parented to ${tipo}; got ${JSON.stringify(ddo_map)}`
				)

				// the columns the client derives from it
				assert.isAbove(
					(instance.columns_map || []).length, 0,
					'columns_map must not be empty for a config-less relation_index with a pointing section'
				)

				// at least one rendered cell of the related_list column inside a row
				const node = await instance.render()
				const rows = [...node.querySelectorAll('.section_record')]
				assert.isAbove(rows.length, 0, 'the pointer must render as a row')
				// rows render with children_view 'text': the cell is a bare
				// `.wrapper_component.component_input_text` span (no tipo class), and an
				// EMPTY value renders no node at all — hence the fixture's test52 value
				const cells = rows.flatMap(row => [...row.querySelectorAll('.wrapper_component.component_input_text')])
				assert.isAbove(cells.length, 0, `expected a rendered ${related_list_tipo} cell in the rows`)
				assert.isTrue(
					cells.some(cell => cell.textContent.includes(pointer_label)),
					`a cell must show the pointer's ${related_list_tipo} value '${pointer_label}'; got ${JSON.stringify(cells.map(cell => cell.textContent))}`
				)
			} finally {
				await instance.destroy(true, true, true)
			}
		})
	}
})//end describe COMPONENT_RELATION_INDEX COLUMNS FROM THE POINTING SECTION




// ─────────────────────────────────────────────
// 5. EVERY INVERSE RELATION RENDERS (owner rule 2026-11-11)
// ─────────────────────────────────────────────
// Whoever reads the index sees ALL its inverse relations (a record is deleted
// on the strength of "nobody points at it"). A caller row from a section the
// viewer CANNOT read arrives as EXISTENCE ONLY: its sqo section item states
// `permissions: 0` + the section label, and no column ddo / cell of it ships
// (server gate: test/unit/relation_index_context_native.test.ts, RULE test).
// The client must render that row with the section NAME + section_id and
// BLANK columns. The suite session reads everything, so the unreadable shape
// is STATED on the built context the way the server states it for a viewer
// without the grant: the pointing section's sqo item reduced to existence
// only, its cells removed from the datum.

describe(`COMPONENT_RELATION_INDEX EVERY INVERSE RELATION RENDERS`, async function() {

	this.timeout(30000)

	const pointer_label		= 'zz suite relation_index pointer'
	const existence_label	= 'zz unreadable section name'

	// state test3 (the pointing section) unreadable on a built instance
	const state_unreadable = function(instance) {
		for (const item of (instance.context.request_config || [])) {
			const sections = item?.sqo?.section_tipo
			if (!Array.isArray(sections)) continue
			item.sqo.section_tipo = sections.map(el => (el && el.tipo===section_tipo)
				? {typo: 'ddo', tipo: el.tipo, model: 'section', permissions: 0, label: existence_label, existence_only: true}
				: el
			)
		}
		// no content of an unreadable section ever ships: drop its cells
		instance.datum.data = instance.datum.data.filter(el => el.mode!=='related_list')
	}

	for (const mode of ['edit', 'list']) {
		for (const view of ['line', 'default']) {

			it(`${model} ${mode}/${view}: one visible row per entry; an unreadable caller shows name + section_id, blank columns`, async function() {

				// readable control: one row per entry, no existence cell
				const readable = await get_relation_index_instance(mode, view)
				let entries = []
				try {
					entries = readable.data?.entries || []
					assert.isAbove(entries.length, 0, 'the runner must install relation_index_pointer_fixture')
					const node = await readable.render()
					const rows = [...node.querySelectorAll('.section_record')]
					assert.equal(rows.length, entries.length, `rendered rows must equal entries (readable ${mode}/${view})`)
					assert.equal(node.querySelectorAll('.target_existence').length, 0, 'a readable row has no existence cell')
				} finally {
					await readable.destroy(true, true, true)
				}

				// unreadable: same entries, existence only
				const instance = await get_relation_index_instance(mode, view)
				try {
					state_unreadable(instance)
					const node = await instance.render()
					const rows = [...node.querySelectorAll('.section_record')]
					assert.equal(rows.length, entries.length, `rendered rows must equal entries (unreadable ${mode}/${view})`)
					for (const row of rows) {
						const existence = row.querySelector('.target_existence')
						assert.isNotNull(existence, `every unreadable row must carry its existence cell; got ${row.outerHTML.slice(0, 300)}`)
						assert.include(existence.textContent, existence_label, 'the section NAME')
						assert.isTrue(
							entries.some(entry => existence.textContent.includes(String(entry.section_id))),
							`the section_id; got '${existence.textContent}'`
						)
						// blank columns: no content of the section
						assert.notInclude(row.textContent, pointer_label, 'no component value of an unreadable section')
						// never a record opener
						assert.equal(row.querySelectorAll('.button_edit').length, 0, 'no open-record button')
					}
				} finally {
					await instance.destroy(true, true, true)
				}
			})
		}
	}
})//end describe COMPONENT_RELATION_INDEX EVERY INVERSE RELATION RENDERS



// @license-end
