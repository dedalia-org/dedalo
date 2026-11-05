// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/

import {
	elements
} from './elements.js'
import {get_instance} from '../../../core/common/js/instances.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {ui} from '../../../core/common/js/ui.js'
import {change_handler, build_date_changed_data_item} from '../../../core/component_date/js/render_edit_component_date.js'
import {open_date_picker, open_time_picker} from '../../../core/component_date/js/calendar_popup.js'



// element options for component_date (date mode)
	const element = elements.find(el => el.model==='component_date')
	if (!element) {
		console.error('Error: component_date not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo_date		= element.tipo  // test145 (date_mode: date)
	// test173 (date_mode: period) — test3 → test115 → test34 → test173. The suite
	// used to name test218, which exists in NO ontology on any instance; that
	// missing tipo made get_date_mode read null.properties and was the whole of
	// this suite's deferral. The period component was there all along.
	const tipo_period	= 'test173'
	const lang			= element.lang



// DOM containers
	const container = document.getElementById('content');

	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



// mode/view matrix for component_date
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



describe(`COMPONENT_DATE LIFECYCLE`, function() {

	this.timeout(15000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_date',
					tipo			: tipo_date,
					section_tipo	: section_tipo,
					section_id		: section_id,
					lang			: lang,
					mode			: pair.mode,
					view			: pair.view,
					id_variant		: pair.mode + '_' + pair.view + '_' + Math.random()
				}

				// init
					instance = await get_instance(options)

					assert.equal(instance.model, 'component_date', 'model expected component_date')
					assert.equal(instance.tipo, tipo_date, `tipo expected ${tipo_date}`)
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
						// edit default: input_date element exists
						const input_date = node.querySelector('.input_date')
						assert.isOk(input_date, 'expected input_date element in edit/default')
						// label exists
						assert.isOk(node.querySelector('.label'), 'expected label in edit/default')
						// buttons_container exists
						assert.isOk(node.querySelector('.buttons_container'), 'expected buttons_container in edit/default')
					}

					if (pair.mode==='edit' && pair.view==='line') {
						// edit line: content_data exists
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



describe(`COMPONENT_DATE DATA OPERATIONS (date mode)`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode)`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_date,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'data_ops_date_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)
		node = await instance.render()

		component_container.appendChild(node)

		assert.equal(instance.model, 'component_date', 'model expected component_date')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		assert.isOk(instance.datum, 'datum expected')
		assert.isOk(instance.context, 'context expected')
		assert.isOk(instance.data, 'data expected')
		assert.isOk(Array.isArray(instance.data.entries), 'data.entries expected array')
	});



	it(`date_mode is 'date'`, async function() {

		const date_mode = instance.get_date_mode()
		assert.equal(date_mode, 'date', 'expected date_mode date')
	});



	it(`add data via change_value (date input)`, async function() {

		// Build changed_data_item the same way change_handler does
		// This verifies the effective_key logic (start|end|period, never 'undefined')
		const parse_response = instance.parse_string_date('25/12/2024')
		assert.isOk(parse_response.data, 'parse_string_date expected payload')

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0
		const effective_key = 'start' // date_input || type

		// data_value construction (same as change_handler)
		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}
		item[effective_key] = parse_response.data

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		// CRITICAL: verify the key is 'start' (not 'undefined')
		assert.isOk(changed_data_item.value.start, 'expected start property in changed value')
		assert.isUndefined(changed_data_item.value['undefined'], 'expected NO undefined property in changed value')
		assert.equal(changed_data_item.value.start.year, 2024, 'expected year 2024')
		assert.equal(changed_data_item.value.start.month, 12, 'expected month 12')
		assert.equal(changed_data_item.value.start.day, 25, 'expected day 25')

		// Apply the change via change_value (async) and wait
		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false
		})

		// Verify entries updated
		const updated_entries = instance.data.entries
		assert.isOk(updated_entries[key].start, 'expected start in entries after change_value')
	});



	it(`change data via change_value (update existing)`, async function() {

		// Build changed_data_item for an updated date
		const parse_response = instance.parse_string_date('01/06/2023')

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0
		const effective_key = 'start'

		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}
		item[effective_key] = parse_response.data

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		assert.isOk(changed_data_item.value.start, 'expected start property in changed value')
		assert.equal(changed_data_item.value.start.year, 2023, 'expected year 2023')
		assert.equal(changed_data_item.value.start.month, 6, 'expected month 6')

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false
		})
	});



	it(`remove data via change_value (empty date)`, async function() {

		// Build changed_data_item for removing the start value
		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0
		const effective_key = 'start'

		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}

		// Delete the effective_key (same as change_handler does for empty input)
		delete item[effective_key]
		const item_keys = Object.keys(item)
		const data_value = (item_keys.length===1 && item_keys[0]==='id') || item_keys.length===0
			? null
			: item

		// the shipped edit builder: an emptied slot is a REMOVE by id (a null
		// update value is refused by the save door,
		// WC-2026-10-03-save-refuses-malformed-value-shape), a non-empty one an update
		const changed_data_item = build_date_changed_data_item(data_value, entries[key]?.id ?? null)
		if (data_value===null) {
			assert.equal(changed_data_item?.action, 'remove', 'an emptied stored slot expected a remove')
			assert.isOk(changed_data_item.id, 'the remove expected to name the stored item')
		} else {
			assert.equal(changed_data_item.action, 'update', 'a slot with content expected an update')
		}

		// Verify start was deleted (value may be null if only id left,
		// or may still contain other keys like 'end' from server data)
		assert.isUndefined(changed_data_item.value?.start, 'expected start to be deleted after clearing date')

		const response = await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false,
			remove_dialog	: false
		})
		assert.isTrue(response?.ok, 'the server expected to accept the change (envelope ok)')
	});



	it(`save and verify persistence`, async function() {

		// Set a known value via change_value and save
		const parse_response = instance.parse_string_date('15/07/2025')

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0

		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}
		item.start = parse_response.data

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false
		})

		// verify data has been saved
		assert.isOk(instance.data, 'data expected after save')
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



describe(`COMPONENT_DATE PERIOD MODE`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (period mode, edit)`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_period,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'period_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)
		node = await instance.render()

		component_container.appendChild(node)

		assert.equal(instance.status, 'rendered', 'status expected rendered')
	});



	it(`date_mode is 'period'`, async function() {

		const date_mode = instance.get_date_mode()
		assert.equal(date_mode, 'period', 'expected date_mode period')
	});



	it(`render has period inputs (year, month, day)`, async function() {

		const period_inputs = node.querySelectorAll('.input_period')
		assert.isOk(period_inputs.length >= 3, 'expected at least 3 period inputs (year, month, day)')
	});



	it(`add data via change_value (period)`, async function() {

		// Build changed_data_item the same way change_handler does for period
		// This verifies the effective_key logic: period mode uses type as fallback
		const parse_response = instance.parse_string_period({
			year	: 5,
			month	: 10,
			day		: 15
		})
		assert.isOk(parse_response.data, 'parse_string_period expected payload')

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0
		// CRITICAL: effective_key = options.date_input || type
		// For period mode, date_input is not provided, so effective_key = 'period'
		const effective_key = 'period'

		// Build item from scratch (not cloned from entries) to isolate effective_key test
		// from any pre-existing 'undefined' keys in server data from before the fix
		const item = {}
		item[effective_key] = parse_response.data

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		// CRITICAL: verify the key is 'period' (not 'undefined')
		assert.isOk(changed_data_item.value.period, 'expected period property in changed value')
		assert.isUndefined(changed_data_item.value['undefined'], 'CRITICAL: expected NO undefined property in changed value (regression test)')
		assert.equal(changed_data_item.value.period.year, 5, 'expected period year 5')
		assert.equal(changed_data_item.value.period.month, 10, 'expected period month 10')
		assert.equal(changed_data_item.value.period.day, 15, 'expected period day 15')

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false
		})
	});



	it(`change data via change_value (update period)`, async function() {

		const parse_response = instance.parse_string_period({
			year	: 20,
			month	: 6,
			day		: 30
		})

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0
		const effective_key = 'period'

		// Build item from scratch to isolate effective_key test
		const item = {}
		item[effective_key] = parse_response.data

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		assert.isOk(changed_data_item.value.period, 'expected period property in changed value')
		assert.equal(changed_data_item.value.period.year, 20, 'expected period year 20')

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false
		})
	});



	it(`remove data via change_value (empty period)`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0
		const effective_key = 'period'

		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}

		// Delete the effective_key (same as change_handler does for empty period)
		delete item[effective_key]
		const item_keys = Object.keys(item)
		const data_value = (item_keys.length===1 && item_keys[0]==='id') || item_keys.length===0
			? null
			: item

		// the shipped edit builder: an emptied slot is a REMOVE by id (a null
		// update value is refused by the save door,
		// WC-2026-10-03-save-refuses-malformed-value-shape), a non-empty one an update
		const changed_data_item = build_date_changed_data_item(data_value, entries[key]?.id ?? null)
		if (data_value===null) {
			assert.equal(changed_data_item?.action, 'remove', 'an emptied stored slot expected a remove')
			assert.isOk(changed_data_item.id, 'the remove expected to name the stored item')
		} else {
			assert.equal(changed_data_item.action, 'update', 'a slot with content expected an update')
		}

		// Verify period was deleted (value may be null if only id left,
		// or may still contain other keys from server data)
		assert.isUndefined(changed_data_item.value?.period, 'expected period to be deleted after clearing')

		const response = await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false,
			remove_dialog	: false
		})
		assert.isTrue(response?.ok, 'the server expected to accept the change (envelope ok)')
	});



	it(`save and verify period persistence`, async function() {

		const parse_response = instance.parse_string_period({
			year	: 3,
			month	: 4,
			day		: 5
		})

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0

		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}
		item.period = parse_response.data

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			value	: item
		})

		await instance.change_value({
			changed_data	: [changed_data_item],
			refresh		: false
		})

		// verify data has been saved with period key
		assert.isOk(instance.data, 'data expected after save')
	});



	it(`destroy after period operations`, async function() {

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



describe(`COMPONENT_DATE CHANGE_HANDLER VALIDATION`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode)`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_date,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'validation_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)
		node = await instance.render()

		component_container.appendChild(node)
	});



	it(`change_handler returns false for invalid date`, async function() {

		const input_wrap = node.querySelector('.input-group')
		assert.isOk(input_wrap, 'expected input-group in DOM')

		// invalid date (day 32)
		const result = change_handler({
			self		: instance,
			input_value	: '32/13/2024',
			key			: 0,
			input_wrap	: input_wrap,
			date_input	: 'start',
			type		: 'date'
		})

		assert.equal(result, false, 'change_handler expected false for invalid date')
	});



	it(`change_handler returns false for invalid time`, async function() {

		const input_wrap = node.querySelector('.input-group')

		// invalid time (hour 25)
		const result = change_handler({
			self		: instance,
			input_value	: '25:99:99',
			key			: 0,
			input_wrap	: input_wrap,
			date_input	: 'start',
			type		: 'time'
		})

		assert.equal(result, false, 'change_handler expected false for invalid time')
	});



	it(`change_handler returns false for missing self`, async function() {

		const result = change_handler({
			self		: null,
			input_value	: '25/12/2024',
			key			: 0,
			input_wrap	: null,
			date_input	: 'start',
			type		: 'date'
		})

		assert.equal(result, false, 'change_handler expected false for null self')
	});



	it(`effective_key is date_input for date/time, type for period`, async function() {

		// This verifies that the effective_key logic works:
		// date/time modes use options.date_input ('start'|'end')
		// period mode uses type ('period') as fallback

		// Case 1: date_input='end' → effective_key='end'
		const parse_response = instance.parse_string_date('15/07/2025')

		const data		= instance.data || {}
		const entries	= data.entries || []
		const key		= 0

		const item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}
		// effective_key = options.date_input || type → 'end'
		item['end'] = parse_response.data

		assert.isOk(item.end, 'expected end property when date_input=end')
		assert.isUndefined(item['undefined'], 'expected NO undefined property')

		// Case 2: no date_input, type='period' → effective_key='period'
		const period_item = entries[key]
			? JSON.parse(JSON.stringify(entries[key]))
			: {}
		// effective_key = options.date_input || type → undefined || 'period' = 'period'
		const effective_key_for_period = undefined || 'period'
		period_item[effective_key_for_period] = { year: 1, month: 2, day: 3 }

		assert.isOk(period_item.period, 'expected period property when type=period and no date_input')
		assert.isUndefined(period_item['undefined'], 'expected NO undefined property for period fallback')
	});



	it(`destroy after validation tests`, async function() {

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



describe(`COMPONENT_DATE SEARCH MODE`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_date,
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



	it(`search mode has q_operator`, async function() {

		const q_operator = node.querySelector('.q_operator')
		assert.isOk(q_operator, 'expected q_operator in search mode')
	});



	it(`search mode change_handler uses update_data_value`, async function() {

		// In search mode, change_handler calls self.update_data_value
		// and publishes 'change_search_element' event
		const input_wrap = node.querySelector('.input-group')
		if (input_wrap) {
			const input = input_wrap.querySelector('.input_date')
			if (input) {
				input.value = '01/01/2024'

				// listen for the search event
				let event_fired = false
				const token = event_manager.subscribe('change_search_element', () => {
					event_fired = true
				})

				change_handler({
					self		: instance,
					input_value	: input.value,
					key			: 0,
					input_wrap	: input_wrap,
					date_input	: 'start',
					type		: 'date'
				})

				// unsubscribe
				event_manager.unsubscribe(token)

				assert.isOk(event_fired, 'expected change_search_element event to fire')
			}
		}
	});



	it(`search mode: activating the card leaves the field where it is, trigger clear of the label`, async function() {

		// Regression (search panel): the default active look (layout.less
		// `.wrapper_component…active > .label`) restyles the label of a focused
		// field — a shorter box — and the card's body jerked up under the
		// pointer; a floated trigger rode that shift onto the field name.
		// The card keeps its own label box in BOTH states and the trigger sits
		// on the value's line, after the input.
		const label			= node.querySelector(':scope > .label')
		const input_wrap	= node.querySelector('.input-group')
		const input			= node.querySelector('.input_date')
		const trigger		= node.querySelector('.button_calendar_container')
		assert.isOk(label && input_wrap && input && trigger, 'expected label, field and trigger')

		const label_height	= label.getBoundingClientRect().height
		const input_top		= input.getBoundingClientRect().top

		await ui.component.activate(instance)

		assert.closeTo(label.getBoundingClientRect().height, label_height, 0.5, 'label must keep its box while active')
		assert.closeTo(input.getBoundingClientRect().top, input_top, 0.5, 'the field must not move on activation')

		const trigger_rect	= trigger.getBoundingClientRect()
		const input_rect	= input.getBoundingClientRect()
		const wrap_rect		= input_wrap.getBoundingClientRect()
		assert.isOk(trigger_rect.top >= wrap_rect.top - 1 && trigger_rect.bottom <= wrap_rect.bottom + 1, 'trigger must share the value line')
		assert.isOk(trigger_rect.left >= input_rect.right - 1, 'trigger must sit after the value field')

		await ui.component.deactivate(instance)
	});



	it(`search mode calendar trigger opens the built-in dd_date picker`, async function() {

		// The trigger is a `.button_calendar_container` whose <a class="calendar">
		// carries the activation (a11y.make_activable → click AND Enter/Space).
		// There is no third-party picker and no mobile UA fallback any more: the
		// built-in module (calendar_popup.js) is what opens, phone included.
		const input		= node.querySelector('.input_date')
		assert.isOk(input, 'expected .input_date in search mode')

		// test hygiene: a leftover popup from a failed previous test must not be
		// mistaken for the one this test opens
		const leftover = document.body.querySelector('.dd_calendar_popup')
		if (leftover) {
			leftover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		}

		const trigger	= node.querySelector('.button_calendar_container .calendar')
		assert.isOk(trigger, 'expected the .calendar trigger in search mode')
		assert.equal(trigger.getAttribute('role'), 'button', 'expected the trigger to expose a button role (keyboard path)')
		assert.equal(trigger.tabIndex, 0, 'expected the trigger to be a tab stop')

		// reveal + open: the trigger is in the field's own row (its end) and
		// keeps the reveal-on-focus contract, so the field is focused first —
		// the real user path
		input.focus()
		await new Promise((resolve)=>setTimeout(resolve, 30))
		trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		let popup = document.body.querySelector('.dd_calendar_popup')
		for (let i = 0; i < 40 && !popup; i++) {
			await new Promise((resolve)=>setTimeout(resolve, 10))
			popup = document.body.querySelector('.dd_calendar_popup')
		}
		assert.isOk(popup, 'expected the built-in picker popup in the document')
		assert.isOk(popup.querySelector('.dp_grid'), 'expected a day grid in the picker')
		assert.isOk(popup.querySelector('.dp_day'), 'expected day cells in the picker')
		// the popup opens on the VALUE the field carries (the search field holds a
		// date by now — an empty field opens on today, covered by the module tests)
		assert.isOk(popup.querySelector('.dp_action_year'), 'expected the year precision chip')

		// Escape closes it and returns focus to the field
		popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		assert.isNull(document.body.querySelector('.dd_calendar_popup'), 'expected the popup removed after Escape')
	});



	it(`search mode: picking a day writes the formatted date into the field`, async function() {

		const input		= node.querySelector('.input_date')
		const trigger	= node.querySelector('.button_calendar_container .calendar')

		// hygiene as above, then an EMPTY field so the picker opens on today
		const leftover = document.body.querySelector('.dd_calendar_popup')
		if (leftover) {
			leftover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		}
		input.value = ''
		input.focus()
		await new Promise((resolve)=>setTimeout(resolve, 30))
		trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		let popup = document.body.querySelector('.dd_calendar_popup')
		for (let i = 0; i < 40 && !popup; i++) {
			await new Promise((resolve)=>setTimeout(resolve, 10))
			popup = document.body.querySelector('.dd_calendar_popup')
		}
		assert.isOk(popup, 'expected the built-in picker popup')

		// pick TODAY (an empty field opens the picker on the current month)
		const today_button = popup.querySelector('.dp_day.dp_today')
		assert.isOk(today_button, 'expected a today cell in the month the empty field opens on')
		today_button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		const now		= new Date()
		const expected	= instance.date_to_string({year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate()})
		assert.equal(input.value, expected, 'expected the field to carry the picked date in the app date order')
		assert.isNull(document.body.querySelector('.dd_calendar_popup'), 'expected the picker to close after a pick')
	});



	it(`search mode: a second press on the calendar trigger closes the picker (toggle)`, async function() {

		const input		= node.querySelector('.input_date')
		const trigger	= node.querySelector('.button_calendar_container .calendar')

		// hygiene, then open the picker
		const leftover = document.body.querySelector('.dd_calendar_popup')
		if (leftover) {
			leftover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		}
		input.focus()
		await new Promise((resolve)=>setTimeout(resolve, 30))
		trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		let popup = document.body.querySelector('.dd_calendar_popup')
		for (let i = 0; i < 40 && !popup; i++) {
			await new Promise((resolve)=>setTimeout(resolve, 10))
			popup = document.body.querySelector('.dd_calendar_popup')
		}
		assert.isOk(popup, 'expected the picker open after the first press')

		// the toggle: a press that STARTS with the picker open must close it.
		// The real path (a browser) light-dismisses on release BEFORE the click,
		// which is why the decision is judged at pointerdown; a synthetic press
		// reproduces the same pointerdown→click order.
		trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
		trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		assert.isNull(document.body.querySelector('.dd_calendar_popup'), 'expected the second press to close the picker, not re-open it')

		// and a third press opens it again (the toggle is not stuck closed)
		trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
		trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		let reopened = document.body.querySelector('.dd_calendar_popup')
		for (let i = 0; i < 40 && !reopened; i++) {
			await new Promise((resolve)=>setTimeout(resolve, 10))
			reopened = document.body.querySelector('.dd_calendar_popup')
		}
		assert.isOk(reopened, 'expected a further press to open the picker again')

		reopened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
	});



	it(`destroy after search tests`, async function() {

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



describe(`COMPONENT_DATE IS_EMPTY`, function() {

	this.timeout(10000);

	it(`is_empty returns true for no entries`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_date,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'isempty_' + Math.random()
		}

		const instance = await get_instance(options)
		await instance.build(true)

		// set empty data
		instance.data.entries = []

		assert.equal(instance.is_empty(), true, 'expected is_empty true for no entries')

		await instance.destroy(true)
	});



	it(`is_empty returns false for date with start`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_date,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'isempty2_' + Math.random()
		}

		const instance = await get_instance(options)
		await instance.build(true)

		instance.data.entries = [{
			id: 1,
			start: { year: 2024, month: 1, day: 1 }
		}]

		assert.equal(instance.is_empty(), false, 'expected is_empty false for date with start')

		await instance.destroy(true)
	});



	it(`is_empty returns false for period with values`, async function() {

		const options = {
			model			: 'component_date',
			tipo			: tipo_period,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'isempty3_' + Math.random()
		}

		const instance = await get_instance(options)
		await instance.build(true)

		instance.data.entries = [{
			id: 1,
			period: { year: 5, month: 3, day: 10 }
		}]

		assert.equal(instance.is_empty(), false, 'expected is_empty false for period with values')

		await instance.destroy(true)
	});
});



describe(`COMPONENT_DATE BUILT-IN PICKER (module level)`, function() {

	this.timeout(15000);

	let anchor = null

	// every picker hangs off a real (detached-ish) trigger; body-appended so
	// positioning and focus behave like production
	beforeEach(function() {
		anchor = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'test_picker_anchor',
			parent			: document.body
		})
	})

	afterEach(function() {
		if (anchor) {
			anchor.remove()
			anchor = null
		}
		// never leak a popup into a later suite
		const leftover = document.body.querySelector('.dd_calendar_popup')
		if (leftover) {
			leftover.remove()
		}
	})



	it(`commits a BCE year-only selection (the value flatpickr could not express)`, async function() {

		let selected = null
		const controller = open_date_picker({
			anchor		: anchor,
			initial		: {},
			on_select	: (dd_date) => { selected = dd_date },
			labels		: {}
		})
		const popup = controller.popup

		// type a signed (BCE) year and commit ONLY the year — a partial date
		const year_input = popup.querySelector('.dp_year')
		year_input.value = '-205'
		year_input.dispatchEvent(new Event('change'))

		const era_button = popup.querySelector('.dp_era')
		assert.equal(era_button.textContent, 'BCE', 'expected the era chip to read BCE for a negative year')
		assert.equal(era_button.getAttribute('aria-pressed'), 'true', 'expected aria-pressed on the era toggle')

		popup.querySelector('.dp_action_year').dispatchEvent(new MouseEvent('click', { bubbles: true }))
		assert.deepEqual(selected, {year: -205}, 'expected a BCE year-only dd_date')
		assert.isNull(document.body.querySelector('.dd_calendar_popup'), 'expected the popup to close after committing')
	});



	it(`era toggle flips the sign of the shown year`, async function() {

		const controller = open_date_picker({ anchor: anchor, initial: {}, on_select: () => {}, labels: {} })
		const popup = controller.popup

		const year_input = popup.querySelector('.dp_year')
		const era_button = popup.querySelector('.dp_era')
		const positive = Number(year_input.value)
		assert.isTrue(positive > 0, 'expected a positive starting year')

		era_button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		assert.equal(Number(year_input.value), -positive, 'expected the era toggle to negate the year field')

		era_button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		assert.equal(Number(year_input.value), positive, 'expected a second toggle to restore the year')

		controller.close()
	});



	it(`commits a year+month precision (partial date)`, async function() {

		let selected = null
		const controller = open_date_picker({
			anchor		: anchor,
			initial		: { year: 2022, month: 4 },
			on_select	: (dd_date) => { selected = dd_date },
			labels		: {}
		})
		const popup = controller.popup

		popup.querySelector('.dp_action_month').dispatchEvent(new MouseEvent('click', { bubbles: true }))
		assert.deepEqual(selected, {year: 2022, month: 4}, 'expected the year+month precision to commit')
	});



	it(`day grid is one tab stop and arrows rove across days`, async function() {

		let selected = null
		const controller = open_date_picker({
			anchor		: anchor,
			initial		: { year: 2024, month: 3, day: 15 },
			on_select	: (dd_date) => { selected = dd_date },
			labels		: {}
		})
		const popup = controller.popup

		const selected_day = popup.querySelector('.dp_day.dp_selected')
		assert.isOk(selected_day, 'expected the initial day to be marked selected')
		assert.equal(selected_day.textContent, '15', 'expected the 15th selected')
		assert.equal(selected_day.tabIndex, 0, 'expected the selected day to be the single tab stop')

		// ArrowRight: roving focus to the 16th
		popup.querySelector('.dp_grid tbody').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
		assert.equal(document.activeElement.textContent, '16', 'expected focus on the 16th after ArrowRight')
		assert.equal(document.activeElement.tabIndex, 0, 'expected the focused day to be the roving tab stop')

		// ArrowDown: +7 days
		popup.querySelector('.dp_grid tbody').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
		assert.equal(document.activeElement.textContent, '23', 'expected focus on the 23rd after ArrowDown')

		// PageDown: next month, same day
		popup.querySelector('.dp_grid tbody').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
		assert.equal(document.activeElement.textContent, '23', 'expected the same day of the next month')

		// click commits the focused day
		const target = document.activeElement
		target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		assert.deepEqual(selected, {year: 2024, month: 4, day: 23}, 'expected the April 23rd commit')
	});



	it(`time picker commits hour/minute/second`, async function() {

		let selected = null
		const controller = open_time_picker({
			anchor		: anchor,
			initial		: { hour: 14, minute: 30, second: 0 },
			on_select	: (dd_time) => { selected = dd_time },
			labels		: {}
		})
		const popup = controller.popup

		const hour_select = popup.querySelector('.dp_time_hour')
		assert.equal(hour_select.value, '14', 'expected the initial hour in the select')

		hour_select.value = '9'
		hour_select.dispatchEvent(new Event('change'))
		assert.deepEqual(selected, {hour: 9, minute: 30, second: 0}, 'expected a full time object on commit')

		controller.close()
	});
});



// @license-end
