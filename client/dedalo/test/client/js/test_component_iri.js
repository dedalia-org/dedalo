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



// element options for component_iri
	const element = elements.find(el => el.model==='component_iri')
	if (!element) {
		console.error('Error: component_iri not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo  // test140
	const lang			= element.lang



// DOM containers
	const container = document.getElementById('content');

	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



// mode/view matrix for component_iri
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



describe(`COMPONENT_IRI LIFECYCLE`, function() {

	this.timeout(15000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_iri',
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

					assert.equal(instance.model, 'component_iri', 'model expected component_iri')
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
						// edit default: content_data with input_value elements
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



describe(`COMPONENT_IRI DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode, permissions=2)`, async function() {

		const options = {
			model			: 'component_iri',
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

		assert.equal(instance.model, 'component_iri', 'model expected component_iri')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(instance.datum, 'datum expected')
		assert.isOk(instance.context, 'context expected')
		assert.isOk(instance.data, 'data expected')
		assert.isOk(Array.isArray(instance.data.entries), 'data.entries expected array')
	});



	it(`data structure`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []

		// component_iri entries have iri (string), title (string), id (int)
		if (entries.length > 0) {
			assert.isOk(entries[0].iri !== undefined, 'entry expected iri property')
			assert.isOk(entries[0].id !== undefined, 'entry expected id property')
		}
	});



	it(`add data via change_value (set_data)`, async function() {

		const changed_data = [Object.freeze({
			action	: 'insert',
			id		: null,
			value	: {
				iri		: 'https://dedalo.dev/test_insert',
				title	: 'Test insert'
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



	it(`actions cluster lies over the url input end (edit layout)`, async function() {

		// component_iri.less: the remove/link cluster overlays the url input's
		// end (zero outer size) instead of taking a row of its own — at any width
		// the row is filled after its dataframe resolves (render_edit get_content_value)
		const find_row = () => [...instance.node.querySelectorAll('.content_value')]
			.find(el => el.querySelector(':scope >.input_value.url') && el.querySelector(':scope >.content_actions'))
		let content_value = find_row()
		for (let i = 0; !content_value && i < 50; i++) {
			await new Promise(resolve => setTimeout(resolve, 100))
			content_value = find_row()
		}
		assert.isOk(content_value, 'expected a content_value with url input + actions cluster')

		const url_node		= content_value.querySelector(':scope >.input_value.url')
		const url_rect		= url_node.getBoundingClientRect()
		// the cluster closes the url's margin box (it follows the input in flow)
		const url_end		= url_rect.right + parseFloat(getComputedStyle(url_node).marginRight)
		const actions_rect	= content_value.querySelector(':scope >.content_actions').getBoundingClientRect()
		assert.isAbove(url_rect.width, 0, 'url input expected rendered')

		const url_mid		= url_rect.top + url_rect.height / 2
		const actions_mid	= actions_rect.top + actions_rect.height / 2
		assert.isBelow(Math.abs(url_mid - actions_mid), 2, 'actions expected on the url line (not wrapped)')
		assert.isBelow(actions_rect.left, url_rect.right, 'actions expected to overlap the url input')
		assert.isAtLeast(actions_rect.left, url_rect.left, 'actions expected not to escape left of the url input')
		assert.isBelow(Math.abs(actions_rect.right - url_end), 2, 'actions expected at the url input end')
	});



	it(`dataframe and title share their line equally, vertically centred (edit layout)`, async function() {

		// component_iri.less: dataframe + title share flex basis/grow (12rem, 1),
		// and the dataframe centres its record (its content_data is taller than
		// the 2rem box and used to hang below the title's text line)
		const find_row = () => [...instance.node.querySelectorAll('.content_value')]
			.find(el => el.querySelector(':scope >.component_dataframe') && el.querySelector(':scope >.input_value.title'))
		let content_value = find_row()
		for (let i = 0; !content_value && i < 50; i++) {
			await new Promise(resolve => setTimeout(resolve, 100))
			content_value = find_row()
		}
		assert.isOk(content_value, 'expected a content_value with dataframe + title input')

		// a WIDE rule (the phone tier puts each on its own line) and the suite
		// frame sits under the breakpoint: widen the frame for this leg, prove it
		// got there, restore it after (as test_portal_row_drag does)
		const frame			= window.frameElement
		const frame_width	= frame ? frame.style.width : null
		if (frame) {
			frame.style.width = '1440px'
		}
		try {
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			assert.equal(window.matchMedia('(min-width: 961px)').matches, true, 'the leg could not reach the wide layout')

			const df_rect		= content_value.querySelector(':scope >.component_dataframe').getBoundingClientRect()
			const title_rect	= content_value.querySelector(':scope >.input_value.title').getBoundingClientRect()
			// what the dataframe shows: its linked record or, empty (the fixture
			// row holds none), the placeholder hint
			const shown_node	= content_value.querySelector(':scope >.component_dataframe .section_record, :scope >.component_dataframe >.list_after >.component_placeholder')
			assert.isOk(shown_node, 'expected a dataframe record or placeholder')
			const record_rect	= shown_node.getBoundingClientRect()
			assert.isAbove(title_rect.width, 0, 'title input expected rendered')
			assert.isBelow(Math.abs(df_rect.top - title_rect.top), 2, 'dataframe and title expected on one line')

			assert.isBelow(Math.abs(df_rect.width - title_rect.width), 2, 'dataframe and title expected equal width')

			const title_mid		= title_rect.top + title_rect.height / 2
			const record_mid	= record_rect.top + record_rect.height / 2
			assert.isBelow(Math.abs(title_mid - record_mid), 2, 'dataframe content expected centred on the title line')
		} finally {
			if (frame) {
				frame.style.width = frame_width
			}
		}
	});



	it(`change data via change_value (update)`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0

		if (entries.length > 0) {
			const current_value = Object.assign({}, entries[key])
			current_value.iri = 'https://dedalo.dev/test_updated'

			const changed_data = [Object.freeze({
				action	: 'update',
				id		: entries[key]?.id || null,
				value	: current_value
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



	it(`check_iri_value validates correctly`, async function() {

		// valid https URL
		assert.equal(instance.check_iri_value('https://dedalo.dev'), true, 'expected valid https URL')
		// valid http URL
		assert.equal(instance.check_iri_value('http://dedalo.dev'), true, 'expected valid http URL')
		// empty value (allowed for cleanup)
		assert.equal(instance.check_iri_value(''), true, 'expected empty value allowed')
		// invalid URL without protocol
		assert.equal(instance.check_iri_value('dedalo.dev'), false, 'expected invalid URL without protocol')
		// invalid URL with ftp protocol
		assert.equal(instance.check_iri_value('ftp://dedalo.dev'), false, 'expected invalid ftp protocol')
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



describe(`COMPONENT_IRI SEARCH DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_iri',
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
		// search mode data has entries array
		assert.isOk(Array.isArray(data.entries), 'data.entries expected array')
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
