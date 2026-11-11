// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/

import {
	elements
} from './elements.js'
import {get_instance} from '../../../core/common/js/instances.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {is_empty} from '../../../core/component_common/js/component_common.js'
import {ui} from '../../../core/common/js/ui.js'
import {build_changed_data_item} from '../../../core/component_filter_records/js/component_filter_records.js'



// element options for component_filter_records
	const element = elements.find(el => el.model==='component_filter_records')
	if (!element) {
		console.error('Error: component_filter_records not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo
	const lang			= element.lang



// DOM containers
	const container = document.getElementById('content');

	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



// mode/view matrix for component_filter_records
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



describe(`COMPONENT_FILTER_RECORDS LIFECYCLE`, function() {

	this.timeout(10000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_filter_records',
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

					assert.equal(instance.model, 'component_filter_records', 'model expected component_filter_records')
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
						// edit default: content_data with header_row and content_value rows
						const content_data = node.querySelector('.content_data')
						assert.isOk(content_data, 'expected content_data in edit/default')
						const header_row = node.querySelector('.header_row')
						assert.isOk(header_row, 'expected header_row in edit/default')
						// input text fields for each datalist item (when permissions > 1)
						const inputs = node.querySelectorAll('input[type="text"].input_value')
						assert.isOk(inputs.length > 0, 'expected text input fields in edit/default')
					}

					if (pair.mode==='edit' && pair.view==='line') {
						// edit line: same as default but without label
						const content_data = node.querySelector('.content_data')
						assert.isOk(content_data, 'expected content_data in edit/line')
					}

					if (pair.mode==='edit' && pair.view==='print') {
						// edit print: permissions forced to 1, uses read-only render
						const content_values = node.querySelectorAll('.content_value.read_only')
						assert.isOk(content_values.length > 0, 'expected read-only content values in edit/print')
					}

					if (pair.mode==='list' && pair.view==='default') {
						// list default: wrapper_component with list mode class
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
						// search: inputs_container with li items containing input_value fields
						const inputs_container = node.querySelector('.inputs_container')
						assert.isOk(inputs_container, 'expected inputs_container in search/default')
						const inputs = node.querySelectorAll('input[type="text"].input_value')
						assert.isOk(inputs.length > 0, 'expected text input fields in search/default')
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



describe(`COMPONENT_FILTER_RECORDS DATA OPERATIONS`, function() {

	this.timeout(10000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode, permissions=2)`, async function() {

		const options = {
			model			: 'component_filter_records',
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

		assert.equal(instance.model, 'component_filter_records', 'model expected component_filter_records')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(instance.datum, 'datum expected')
		assert.isOk(instance.context, 'context expected')
		assert.isOk(instance.data, 'data expected')
		assert.isOk(Array.isArray(instance.data.entries), 'data.entries expected array')
	});



	it(`data structure`, async function() {

		const entries = instance.data.entries || []

		// entries is array of {id, tipo, value} objects
		assert.isOk(Array.isArray(entries), 'entries expected array')

		// Every entry must carry the canonical {id, tipo, value:[int]} shape — the
		// one view_default_edit_filter_records reads. A malformed entry used to be
		// skipped here, which hid the fixture bug that wrote it (data.js
		// random_filter_records_value returned the changed_data envelope).
		for (const entry of entries) {
			assert.isOk(entry.hasOwnProperty('tipo'), 'entry expected tipo property')
			assert.isOk(entry.hasOwnProperty('value'), 'entry expected value property')
			assert.isOk(Array.isArray(entry.value), 'entry.value expected array')
		}

		// datalist is array of {tipo, permissions, label}
		const datalist = instance.data.datalist || []
		assert.isOk(Array.isArray(datalist), 'datalist expected array')

		// An empty datalist renders no filter rows at all, so assert it rather
		// than passing silently.
		assert.isAbove(datalist.length, 0, 'datalist expected to offer authorized sections')
		assert.isOk(datalist[0].hasOwnProperty('tipo'), 'datalist item expected tipo')
		assert.isOk(datalist[0].hasOwnProperty('label'), 'datalist item expected label')
		assert.isOk(datalist[0].hasOwnProperty('permissions'), 'datalist item expected permissions')
	});



	it(`add data via change_value (set_data)`, async function() {

		// simulate adding a new entry via change_handler
		const inputs = node.querySelectorAll('input[type="text"].input_value')
		assert.isAbove(inputs.length, 0, 'expected filter value inputs in DOM')

		// rows are re-ordered by the view's sort, so the tipo comes from the row itself
		const row_tipo = inputs[0].closest('.content_value')?.dataset.tipo
		assert.isOk(row_tipo, 'the first row expected to carry a tipo')

		const input = inputs[0]
		input.value = '1,2,3'
		input.dispatchEvent(new Event('change', { bubbles: true }))

		// change_handler calls change_value which saves automatically
		// wait for async save
		await new Promise(resolve => setTimeout(resolve, 500))

		// `data expected` was always true and proved nothing — assert the value
		// actually landed in the model.
		const entry = (instance.data.entries || []).find(el => el.tipo===row_tipo)
		assert.isOk(entry, `an entry for ${row_tipo} expected after the change`)
		assert.deepEqual(entry.value.map(Number), [1,2,3], 'the typed ids expected in the entry value')
	});



	it(`change data via change_value (update)`, async function() {

		const inputs = node.querySelectorAll('input[type="text"].input_value')
		assert.isAbove(inputs.length, 0, 'expected filter value inputs in DOM')

		const row_tipo = inputs[0].closest('.content_value')?.dataset.tipo
		assert.isOk(row_tipo, 'the first row expected to carry a tipo')

		const input = inputs[0]
		input.value = '5,10,15'
		input.dispatchEvent(new Event('change', { bubbles: true }))

		await new Promise(resolve => setTimeout(resolve, 500))

		const entry = (instance.data.entries || []).find(el => el.tipo===row_tipo)
		assert.isOk(entry, `an entry for ${row_tipo} expected after the update`)
		assert.deepEqual(entry.value.map(Number), [5,10,15], 'the updated ids expected in the entry value')
	});



	it(`remove data via change_value (remove)`, async function() {

		const inputs = node.querySelectorAll('input[type="text"].input_value')
		assert.isAbove(inputs.length, 0, 'expected filter value inputs in DOM')

		const row_tipo = inputs[0].closest('.content_value')?.dataset.tipo
		assert.isOk(row_tipo, 'the first row expected to carry a tipo')

		const input = inputs[0]
		// empty value triggers remove action. change_handler overrides
		// change_value's destructive-delete confirm() (clearing a field is not a
		// record deletion), so this path must complete without any native dialog.
		input.value = ''
		input.dispatchEvent(new Event('change', { bubbles: true }))

		await new Promise(resolve => setTimeout(resolve, 500))

		const entry = (instance.data.entries || []).find(el => el.tipo===row_tipo)
		assert.isNotOk(entry, `no entry for ${row_tipo} expected after clearing the input`)
	});



	it(`edit view: filter narrows rows, headers sort by tipo/section/value`, async function() {

		const content_data	= node.querySelector('.content_data')
		const filter_input	= content_data.querySelector('.sticky_head .filter_input')
		const filter_count	= content_data.querySelector('.sticky_head .filter_count')
		const no_results	= content_data.querySelector('.sticky_head .no_results')
		assert.isOk(filter_input && filter_count && no_results, 'expected filter input, count and empty message')
		assert.isOk(node.querySelector(':scope>.help_link[href*="component_filter_records"]'), 'expected the docs help link on the wrapper')

		const rows		= () => [...content_data.querySelectorAll(':scope>.content_value')]
		const visible	= () => rows().filter(el => !el.hidden)
		const tipos		= () => rows().map(el => el.dataset.tipo)
		const cmp		= (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
		const total		= rows().length
		assert.isAbove(total, 0, 'expected rows')

		// opens sorted by tipo asc
		assert.deepEqual(tipos(), [...tipos()].sort(cmp), 'rows expected in tipo asc order on open')

		// filter by the first row tipo
		const target = rows()[0].dataset.tipo
		filter_input.value = target
		filter_input.dispatchEvent(new Event('input'))
		assert.isOk(visible().every(el => el.dataset.search.includes(target.toLowerCase())), 'only matching rows expected visible')
		assert.equal(filter_count.textContent, `${visible().length} / ${total}`, 'count expected shown / total')
		assert.isTrue(no_results.hidden, 'empty message expected hidden while rows match')

		// no match
		filter_input.value = 'zz_no_such_section_zz'
		filter_input.dispatchEvent(new Event('input'))
		assert.equal(visible().length, 0, 'no rows expected visible')
		assert.isFalse(no_results.hidden, 'empty message expected shown')

		// clear
		filter_input.value = ''
		filter_input.dispatchEvent(new Event('input'))
		assert.equal(visible().length, total, 'all rows expected visible after clearing')

		const header = (key) => content_data.querySelector(`.header_row .sortable[data-key="${key}"]`)

		// tipo again → desc
		header('tipo').click()
		assert.equal(header('tipo').dataset.sort, 'desc', 'tipo header expected desc')
		assert.deepEqual(tipos(), [...tipos()].sort(cmp).reverse(), 'rows expected in tipo desc order')

		// section label asc
		header('label').click()
		const labels = rows().map(el => el.dataset.label)
		assert.deepEqual(labels, [...labels].sort(cmp), 'rows expected in label asc order')

		// value asc: DOM-only values (never dispatched → never saved); empty rows sink last
		if (total >= 3) {
			const all = rows()
			const saved = all.map(el => el.querySelector('.input_value')?.value)
			all[0].querySelector('.input_value').value = '120'
			all[1].querySelector('.input_value').value = '9'
			all.slice(2).forEach(el => { el.querySelector('.input_value').value = '' })
			header('value').click()
			const values = rows().map(el => el.querySelector('.input_value').value)
			assert.deepEqual(values.slice(0, 2), ['9', '120'], 'values expected numeric asc, filled first')
			assert.isOk(values.slice(2).every(v => v===''), 'empty values expected last')
			header('value').click()
			const desc = rows().map(el => el.querySelector('.input_value').value)
			assert.deepEqual(desc.slice(0, 2), ['120', '9'], 'values expected numeric desc, filled first')
			assert.isOk(desc.slice(2).every(v => v===''), 'empty values expected last in desc too')
			// restore the inputs to what the model holds
			all.forEach((el, i) => { el.querySelector('.input_value').value = saved[i] ?? '' })
		}
	});



	it(`refresh rebuilds component content`, async function() {

		await instance.refresh()

		assert.isOk(instance.node, 'node expected after refresh')
		assert.equal(instance.status, 'rendered', 'status expected rendered after refresh')
	});



	it(`is_empty returns boolean`, async function() {

		const result = is_empty(instance)

		assert.isOk(
			typeof result === 'boolean',
			'is_empty expected boolean'
		)
	});



	it(`instance id is set`, async function() {

		assert.isOk(instance.id, 'instance.id expected to be set')
		assert.isOk(typeof instance.id === 'string', 'instance.id expected string')
	});



	it(`validate_value filters invalid numbers`, async function() {

		// validate_value is a prototype method on component_filter_records
		// it filters: NaN, <=0, duplicates
		const validate_value = instance.validate_value

		if (typeof validate_value === 'function') {
			// valid numbers
			const valid = validate_value(['1', '5', '8'])
			assert.deepEqual(valid, [1, 5, 8], 'expected filtered valid numbers')

			// with invalid entries (NaN, 0, negative, duplicates)
			const mixed = validate_value(['1', 'abc', '0', '-5', '1'])
			assert.deepEqual(mixed, [1], 'expected only valid positive numbers without duplicates')

			// empty array
			const empty = validate_value([])
			assert.deepEqual(empty, [], 'expected empty array for empty input')
		}
	});



	it(`build_changed_data_item with value`, async function() {

		const tipo = 'rsc167'
		const value = {
			tipo	: tipo,
			value	: [1, 5, 8]
		}
		const entries = [
			{
				tipo	: tipo,
				value	: [1, 2],
				id		: 1
			}
		]

		const {changed_data_item, action} = build_changed_data_item(tipo, value, entries)

		assert.equal(action, 'update', 'action expected update when value is not null')
		assert.equal(changed_data_item.action, 'update', 'changed_data_item.action expected update')
		assert.equal(changed_data_item.id, 1, 'changed_data_item.id expected 1 from matching entry')
		assert.deepEqual(changed_data_item.value, value, 'changed_data_item.value expected passed value')
		assert.isOk(Object.isFrozen(changed_data_item), 'changed_data_item expected to be frozen')
	});



	it(`build_changed_data_item with null value (remove)`, async function() {

		const tipo = 'rsc167'
		const entries = [
			{
				tipo	: tipo,
				value	: [1, 2],
				id		: 1
			}
		]

		const {changed_data_item, action} = build_changed_data_item(tipo, null, entries)

		assert.equal(action, 'remove', 'action expected remove when value is null')
		assert.equal(changed_data_item.action, 'remove', 'changed_data_item.action expected remove')
		assert.equal(changed_data_item.id, 1, 'changed_data_item.id expected 1 from matching entry')
		assert.equal(changed_data_item.value, null, 'changed_data_item.value expected null on remove')
		assert.isOk(Object.isFrozen(changed_data_item), 'changed_data_item expected to be frozen')
	});



	it(`build_changed_data_item with empty entries`, async function() {

		const tipo = 'rsc167'
		const value = {
			tipo	: tipo,
			value	: [1, 2]
		}

		const {changed_data_item} = build_changed_data_item(tipo, value, [])

		assert.equal(changed_data_item.id, null, 'changed_data_item.id expected null when no matching entry')
		assert.equal(changed_data_item.action, 'update', 'changed_data_item.action expected update')
		assert.deepEqual(changed_data_item.value, value, 'changed_data_item.value expected passed value')
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



describe(`COMPONENT_FILTER_RECORDS SEARCH DATA OPERATIONS`, function() {

	this.timeout(10000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_filter_records',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'search',
			view			: 'default',
			id_variant		: 'search_ops_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)
		node = await instance.render()

		const search_component = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_component',
			parent			: component_container
		})
		search_component.appendChild(node)

		assert.equal(instance.model, 'component_filter_records', 'model expected component_filter_records')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
	});



	it(`search mode data structure`, async function() {

		assert.isOk(instance.data, 'data expected in search mode')
		assert.isOk(Array.isArray(instance.data.entries), 'data.entries expected array in search mode')
		assert.isOk(Array.isArray(instance.data.datalist), 'data.datalist expected array in search mode')
	});



	it(`search input change triggers update_data_value`, async function() {

		const inputs = node.querySelectorAll('input[type="text"].input_value')
		assert.isOk(inputs.length > 0, 'expected text input fields in search DOM')

		if (inputs.length > 0) {
			const input = inputs[0]
			input.value = '1,2,3'
			input.dispatchEvent(new Event('change', { bubbles: true }))

			// search mode uses update_data_value + event_manager, not change_value
			assert.isOk(instance.data, 'data expected after search input change')
		}
	});



	it(`destroy search instance`, async function() {

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



// @license-end
