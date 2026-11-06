// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/

import {
	elements
} from './elements.js'
import {get_instance} from '../../../core/common/js/instances.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {is_empty} from '../../../core/component_common/js/component_common.js'
import {ui} from '../../../core/common/js/ui.js'
import {handle_json_change} from '../../../core/component_json/js/component_json.js'



// element options for component_json
	const element = elements.find(el => el.model==='component_json')
	if (!element) {
		console.error('Error: component_json not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo  // test18
	const lang			= element.lang



// DOM containers
const container = document.getElementById('content');

const component_container = ui.create_dom_element({
	element_type	: 'div',
	class_name		: 'component_container',
	parent			: container
})



// mode/view matrix for component_json
// edit: default, line, print, mini, text
// list: default, mini, text, collapse
// search: default
const mode_view_pairs = [
	{ mode: 'edit',	view: 'default'	},
	{ mode: 'edit',	view: 'line'	},
	{ mode: 'edit',	view: 'print'	},
	{ mode: 'edit',	view: 'mini'	},
	{ mode: 'edit',	view: 'text'	},
	{ mode: 'list',	view: 'default'	},
	{ mode: 'list',	view: 'mini'	},
	{ mode: 'list',	view: 'text'	},
	{ mode: 'list',	view: 'collapse'},
	{ mode: 'search',view: 'default'	}
]



describe(`COMPONENT_JSON LIFECYCLE`, function() {

	this.timeout(15000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_json',
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

					assert.equal(instance.model, 'component_json', 'model expected component_json')
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
						// edit default: content_data with content_value elements
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in edit/default')
						// buttons_container exists (permissions > 1)
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

					if (pair.mode==='edit' && pair.view==='mini') {
						// edit mini: mini wrapper
						assert.isOk(node.classList.contains('mini'), 'expected mini class in edit/mini')
					}

					if (pair.mode==='edit' && pair.view==='text') {
						// edit text: span element
						assert.equal(node.nodeName, 'SPAN', 'expected SPAN node in edit/text')
					}

					if (pair.mode==='list' && pair.view==='default') {
						// list default: wrapper with list mode class
						assert.isOk(node.classList.contains('list'), 'expected list class in list/default')
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in list/default')
					}

					if (pair.mode==='list' && pair.view==='mini') {
						// list mini: mini wrapper
						assert.isOk(node.classList.contains('mini'), 'expected mini class in list/mini')
					}

					if (pair.mode==='list' && pair.view==='text') {
						// list text: span element
						assert.equal(node.nodeName, 'SPAN', 'expected SPAN node in list/text')
					}

					if (pair.mode==='list' && pair.view==='collapse') {
						// list collapse: wrapper with collapsed class
						assert.isOk(node.classList.contains('collapsed'), 'expected collapsed class in list/collapse')
					}

					if (pair.mode==='search') {
						// search: q_operator input and content_data
						const q_operator = node.querySelector('.q_operator')
						assert.isOk(q_operator, 'expected q_operator input in search/default')
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



describe(`COMPONENT_JSON DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode, permissions=2)`, async function() {

		const options = {
			model			: 'component_json',
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
		node = await instance.render()

		component_container.appendChild(node)

		assert.equal(instance.model, 'component_json', 'model expected component_json')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(instance.datum, 'datum expected')
		assert.isOk(instance.context, 'context expected')
		assert.isOk(instance.data, 'data expected')
		// component_json contract allows entries to be null/undefined for an empty record
		assert.isOk(instance.data.entries==null || Array.isArray(instance.data.entries), 'data.entries expected array or null')
	});



	it(`data structure`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []

		// component_json entries have value (object/array/primitive) and id
		if (entries.length > 0) {
			assert.isOk(entries[0].value !== undefined, 'entry expected value property')
			assert.isOk(entries[0].id !== undefined, 'entry expected id property')
		}
	});



	it(`add data via change_value (set_data)`, async function() {

		const changed_data = [Object.freeze({
			action	: 'insert',
			id		: null,
			value	: {
				value	: { test_insert: 'hello' }
			}
		})]

		await instance.change_value({
			changed_data	: changed_data,
			refresh		: true
		})

		// verify entry was added
		const entries = instance.data.entries || []
		assert.isOk(entries.length > 0, 'expected at least 1 entry after insert')
	});



	it(`editing back to the stored value clears the unsaved state`, async function() {

		const stored = instance.db_data?.entries?.[0]
		assert.isOk(stored, 'expected a stored entry (added by the insert above)')

		// an edit marks the component modified (Save is highlighted from this class)
		handle_json_change(instance, { json : { revert_probe : 1 } }, 0)
		assert.isTrue(instance.node.classList.contains('modified'), 'edit expected modified')

		// typing the stored value again is a revert, not a change
		handle_json_change(instance, { json : structuredClone(stored.value) }, 0)
		assert.isFalse(instance.node.classList.contains('modified'), 'revert expected not modified')
		assert.equal((instance.data.changed_data || []).length, 0, 'revert expected no pending change')
	});



	it(`deactivate saves a pending edit (auto-save like every component)`, async function() {

		await ui.component.activate(instance, false)
		handle_json_change(instance, { json : { deactivate_probe : 1 } }, 0)
		assert.isTrue(instance.node.classList.contains('modified'), 'edit expected modified')

		await ui.component.deactivate(instance)

		// deactivate saves fire-and-forget: wait for that save to settle
		const started = Date.now()
		while ((instance.changing===true || instance.saving===true) && Date.now() - started < 8000) {
			await new Promise(resolve => setTimeout(resolve, 50))
		}
		assert.deepEqual(instance.db_data?.entries?.[0]?.value, { deactivate_probe : 1 }, 'deactivate expected the edit saved')
		assert.equal((instance.data.changed_data || []).length, 0, 'saved edit expected no pending change')
		assert.isFalse(instance.node.classList.contains('modified'), 'saved edit expected not modified')
	});



	it(`change data via change_value (update)`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0

		if (entries.length > 0) {
			const changed_data = [Object.freeze({
				action	: 'update',
				id		: entries[key]?.id || null,
				value	: { value : { test_update: 'updated' } }
			})]

			await instance.change_value({
				changed_data	: changed_data,
				refresh		: false
			})
		}
	});



	it(`remove data via change_value (remove)`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []

		if (entries.length > 0) {
			const changed_data = [Object.freeze({
				action	: 'remove',
				id		: entries[0]?.id || null,
				value	: null
			})]

			await instance.change_value({
				changed_data	: changed_data,
				refresh			: true,
				remove_dialog 	: () => true
			})
		}
	});



	it(`refresh rebuilds component`, async function() {

		await instance.refresh()

		assert.equal(instance.status, 'rendered', 'status expected rendered after refresh')
		assert.isOk(instance.node instanceof Element, 'node expected DOM Element after refresh')
	});



	it(`is_empty returns boolean`, async function() {

		const result = is_empty(instance)

		assert.equal(typeof result, 'boolean', 'is_empty expected boolean')
	});



	it(`instance id is set`, async function() {

		assert.isOk(instance.id, 'instance.id expected to be set')
		assert.equal(typeof instance.id, 'string', 'instance.id expected string')
	});



	it(`save_on_deactivate is true`, async function() {

		assert.equal(instance.save_on_deactivate, true, 'save_on_deactivate expected true for component_json (auto-saves like every component)')
	});



	it(`q_split is true`, async function() {

		assert.equal(instance.q_split, true, 'q_split expected true for component_json')
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



describe(`COMPONENT_JSON SEARCH DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_json',
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



	it(`search mode has q_operator DOM element`, async function() {

		// q_operator is a DOM input element
		const q_operator = node.querySelector('.q_operator')
		assert.isOk(q_operator, 'expected q_operator DOM element in search mode')
	});



	it(`search mode data structure`, async function() {

		const data = instance.data || {}
		// search mode data: entries is an array, or null/undefined when empty
		assert.isOk(data.entries==null || Array.isArray(data.entries), 'data.entries expected array or null')
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



// @license-end
