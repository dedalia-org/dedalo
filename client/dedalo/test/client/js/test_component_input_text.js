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



// element options for component_input_text
	const element = elements.find(el => el.model==='component_input_text')
	if (!element) {
		console.error('Error: component_input_text not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo  // test52
	const lang			= element.lang



// DOM containers
	const container = document.getElementById('content');

	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



// mode/view matrix for component_input_text
// edit: default, line, colorpicker, mini, text, print
// list: default, mini, text, ip
// search: default
	const mode_view_pairs = [
		{ mode: 'edit',	view: 'default'		},
		{ mode: 'edit',	view: 'line'		},
		{ mode: 'edit',	view: 'mini'		},
		{ mode: 'edit',	view: 'text'		},
		{ mode: 'edit',	view: 'colorpicker'	},
		{ mode: 'edit',	view: 'print'		},
		{ mode: 'list',	view: 'default'		},
		{ mode: 'list',	view: 'mini'		},
		{ mode: 'list',	view: 'text'		},
		{ mode: 'list',	view: 'ip'			},
		{ mode: 'search',view: 'default'		}
	]



describe(`COMPONENT_INPUT_TEXT LIFECYCLE`, function() {

	this.timeout(15000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_input_text',
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

					assert.equal(instance.model, 'component_input_text', 'model expected component_input_text')
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
						// edit default: input_value element exists
						const input_value = node.querySelector('.input_value')
						assert.isOk(input_value, 'expected input_value element in edit/default')
						// content_data exists
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in edit/default')
						// buttons_container exists (permissions > 1)
						assert.isOk(node.querySelector('.buttons_container'), 'expected buttons_container in edit/default')
					}

					if (pair.mode==='edit' && pair.view==='line') {
						// edit line: content_data exists, no label
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in edit/line')
						assert.isOk(node.classList.contains('view_line'), 'expected view_line class')
					}

					if (pair.mode==='edit' && pair.view==='mini') {
						// edit mini: span with component_input_text_mini class
						assert.isOk(node.classList.contains('mini'), 'expected mini class in edit/mini')
					}

					if (pair.mode==='edit' && pair.view==='text') {
						// edit text: clean span
						assert.equal(node.nodeName, 'SPAN', 'expected SPAN node in edit/text')
					}

					if (pair.mode==='edit' && pair.view==='colorpicker') {
						// edit colorpicker: input type color and view_colorpicker class
						assert.isOk(node.classList.contains('view_colorpicker'), 'expected view_colorpicker class in edit/colorpicker')
						const color_picker = node.querySelector('input.color_picker')
						assert.isOk(color_picker, 'expected color_picker input element in edit/colorpicker')
					}

					if (pair.mode==='edit' && pair.view==='print') {
						// edit print: permissions forced to 1, read_only content
						const read_only = node.querySelector('.read_only')
						assert.isOk(read_only, 'expected read_only element in edit/print')
						// FIELD GRID: a read-only value is a plain block with no input
						// to carry --field_box_bleed, so its text must still land on the
						// same left inset as the label above it.
						const label = node.querySelector(':scope > .label')
						assert.isOk(label, 'expected label in edit/print')
						const text_left = (el) => el.getBoundingClientRect().left
							+ parseFloat(getComputedStyle(el).paddingLeft || 0)
						assert.closeTo(text_left(read_only), text_left(label), 1, 'read-only value text must align with its label')
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

					if (pair.mode==='list' && pair.view==='ip') {
						// list ip: ip view specific structure
						assert.isOk(node, 'expected node in list/ip')
					}

					if (pair.mode==='search') {
						// search: content_data with input_value
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in search/default')
						const input_value = node.querySelector('.input_value')
						assert.isOk(input_value, 'expected input_value element in search/default')
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



describe(`COMPONENT_INPUT_TEXT DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode, permissions=2)`, async function() {

		const options = {
			model			: 'component_input_text',
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

		assert.equal(instance.model, 'component_input_text', 'model expected component_input_text')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(instance.datum, 'datum expected')
		assert.isOk(instance.context, 'context expected')
		assert.isOk(instance.data, 'data expected')
		assert.isOk(Array.isArray(instance.data.entries), 'data.entries expected array')
	});



	it(`data structure`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []

		// component_input_text entries have value (string) and lang
		if (entries.length > 0) {
			assert.isOk(entries[0].value !== undefined, 'entry expected value property')
			assert.isOk(entries[0].lang !== undefined, 'entry expected lang property')
		}
	});



	it(`add data via change_value (insert)`, async function() {

		const changed_data = [Object.freeze({
			action	: 'insert',
			id		: null,
			value	: {
				value	: 'TestInsertValue',
				lang	: lang
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



	it(`change data via change_value (update)`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0

		if (entries.length > 0) {
			const changed_data = [Object.freeze({
				action	: 'update',
				id		: entries[key]?.id || null,
				value	: {
					value	: 'TestUpdatedValue',
					lang	: lang
				}
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



	it(`validate method exists`, async function() {

		assert.equal(typeof instance.validate, 'function', 'validate expected to be a function')
	});



	it(`find_equal method exists`, async function() {

		assert.equal(typeof instance.find_equal, 'function', 'find_equal expected to be a function')
	});



	// REGRESSION: a search that matches NOTHING still returns the 'sections'
	// envelope for the caller tipo, with an EMPTY entries array. find_equal used to
	// read entries[0].section_id unguarded and threw
	// "Cannot read properties of undefined (reading 'section_id')", which killed the
	// edit render of every section carrying a `unique` input_text (e.g. hierarchy1).
	// The NO-duplicate case is the COMMON case, so this is the path that must not throw.
	it(`find_equal resolves null when no duplicate exists`, async function() {

		const unique_value = 'zz_no_such_value_' + Date.now()

		const result = await instance.find_equal(unique_value)

		assert.equal(result, null, 'find_equal expected null when nothing matches')
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



describe(`COMPONENT_INPUT_TEXT SEARCH DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_input_text',
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



	it(`search mode has input_value DOM element`, async function() {

		// search mode renders an input for search value entry
		const input_value = node.querySelector('.input_value')
		assert.isOk(input_value, 'expected input_value DOM element in search mode')
	});



	it(`search mode has content_data`, async function() {

		assert.isOk(node.querySelector('.content_data'), 'expected content_data in search mode')
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
