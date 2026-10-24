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
import {
	MATCH_LIMIT,
	filter_tree,
	item_matches,
	normalize_text,
	parse_query
} from '../../../core/component_security_access/js/security_access_filter.js'



// element options for component_security_access
	const element = elements.find(el => el.model==='component_security_access')
	if (!element) {
		console.error('Error: component_security_access not found in elements');
	}

	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo  // test157
	const lang			= element.lang



// DOM containers
	const container = document.getElementById('content');

	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container',
		parent			: container
	})



// mode/view matrix for component_security_access
// edit: default, line, print
// list: default, mini, text
// search: default
	const mode_view_pairs = [
		{ mode: 'edit',	view: 'default'	},
		{ mode: 'edit',	view: 'line'		},
		{ mode: 'edit',	view: 'print'		},
		{ mode: 'list',	view: 'default'	},
		{ mode: 'list',	view: 'mini'		},
		{ mode: 'list',	view: 'text'		},
		{ mode: 'search',view: 'default'	}
	]



describe(`COMPONENT_SECURITY_ACCESS LIFECYCLE`, function() {

	this.timeout(15000);



	// LIFECYCLE TESTS: init, build, render, destroy across all mode/view pairs
	for (let i = 0; i < mode_view_pairs.length; i++) {

		const pair = mode_view_pairs[i]

		describe(`${pair.mode} / ${pair.view}`, function() {

			let instance = null
			let node	 = null

			it(`init → build → render`, async function() {

				const options = {
					model			: 'component_security_access',
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

					assert.equal(instance.model, 'component_security_access', 'model expected component_security_access')
					assert.equal(instance.tipo, tipo, `tipo expected ${tipo}`)
					assert.equal(instance.section_tipo, section_tipo, `section_tipo expected ${section_tipo}`)
					assert.equal(instance.section_id, section_id, `section_id expected ${section_id}`)
					assert.equal(instance.mode, pair.mode, `mode expected ${pair.mode}`)
					assert.equal(instance.lang, lang, `lang expected ${lang}`)

				// build
					await instance.build(true)
					assert.equal(instance.status, 'built', 'status expected built after build')

				// render
					node = await instance.render()
					assert.isOk(node instanceof Element, 'node expected DOM Element')
					// status is 'rendered' only when context is available;
					// without context, common.render returns an error node but status stays 'built'
					if (instance.context) {
						assert.equal(instance.status, 'rendered', 'status expected rendered after render (context present)')
					} else {
						assert.equal(instance.status, 'built', 'status expected built when context is null')
					}
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
						// edit default: content_data with tree_root (ul)
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in edit/default')
						assert.isOk(node.querySelector('.tree_root'), 'expected tree_root ul in edit/default')
						assert.isOk(node.querySelector('.li_item'), 'expected li_item nodes in edit/default')
						// buttons_container exists (permissions > 1)
						assert.isOk(node.querySelector('.buttons_container'), 'expected buttons_container in edit/default')
					}

					if (pair.mode==='edit' && pair.view==='line') {
						// edit line: content_data exists, no label
						assert.isOk(node.querySelector('.content_data'), 'expected content_data in edit/line')
						assert.isOk(node.classList.contains('view_line'), 'expected view_line class')
					}

					if (pair.mode==='edit' && pair.view==='print') {
						// edit print: permissions forced to 1, renders default tree in read-only mode
						assert.isOk(node.classList.contains('view_print'), 'expected view_print class in edit/print')
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
						// search: content_data
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



describe(`COMPONENT_SECURITY_ACCESS DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (edit mode, permissions=2)`, async function() {

		const options = {
			model			: 'component_security_access',
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

		assert.equal(instance.model, 'component_security_access', 'model expected component_security_access')
		assert.equal(instance.status, 'rendered', 'status expected rendered')
		// datum and context may be null for component_security_access in test env
		assert.isOk(instance.data !== undefined, 'data expected')
	});



	it(`data structure`, async function() {

		const data		= instance.data || {}
		const entries	= data.entries || []
		const datalist	= data.datalist || []

		// component_security_access entries have tipo, section_tipo, value
		if (entries.length > 0) {
			assert.isOk(entries[0].tipo !== undefined, 'entry expected tipo property')
			assert.isOk(entries[0].section_tipo !== undefined, 'entry expected section_tipo property')
			assert.isOk(entries[0].value !== undefined, 'entry expected value property')
		}

		// datalist should be present (ontology tree). An empty one leaves the
		// permission tree with nothing to render, so assert it rather than
		// passing silently.
		assert.isAbove(datalist.length, 0, 'datalist expected to carry the ontology tree')
		assert.isOk(datalist[0].tipo !== undefined, 'datalist item expected tipo property')
		assert.isOk(datalist[0].section_tipo !== undefined, 'datalist item expected section_tipo property')
		assert.isOk(datalist[0].model !== undefined, 'datalist item expected model property')
	});



	it(`filled_value is populated on build`, async function() {

		// component_security_access creates filled_value in build
		// merging datalist with entries, filling missing items with value 0
		assert.isOk(Array.isArray(instance.filled_value), 'filled_value expected array')
	});



	it(`update_value method works`, async function() {

		// update_value adds/updates a permission item
		const item = {
			tipo			: 'test45',
			section_tipo	: 'test3',
			ar_parent		: ['test3']
		}
		const input_value = 2

		const result = instance.update_value(item, input_value)

		assert.isOk(Array.isArray(result), 'update_value expected array return')
		// verify the item was added/updated
		const found = result.find(el => el.tipo==='test45' && el.section_tipo==='test3')
		assert.isOk(found, 'expected updated item in result')
		assert.equal(found.value, 2, 'expected value 2 for updated item')
	});



	it(`get_parents method works`, async function() {

		const datalist = instance.data.datalist || []
		assert.isAbove(datalist.length, 0, 'datalist expected to carry the ontology tree')

		const item = datalist.find(el => el.ar_parent && el.ar_parent.length > 0)
		assert.isOk(item, 'datalist expected to carry an item with ar_parent')

		const parents = instance.get_parents(item)
		assert.isOk(Array.isArray(parents), 'get_parents expected array return')
	});



	it(`get_children method works`, async function() {

		const datalist = instance.data.datalist || []
		assert.isAbove(datalist.length, 0, 'datalist expected to carry the ontology tree')

		// find an area/section item (tipo===section_tipo), the ones that have children
		const item = datalist.find(el => el.tipo===el.section_tipo)
		assert.isOk(item, 'datalist expected to carry a section-level item')

		const children = instance.get_children(item)
		assert.isOk(Array.isArray(children), 'get_children expected array return')
	});



	it(`save_changes method exists`, async function() {

		assert.equal(typeof instance.save_changes, 'function', 'save_changes expected to be a function')
	});



	it(`update_parents_radio_butons method exists`, async function() {

		assert.equal(typeof instance.update_parents_radio_butons, 'function', 'update_parents_radio_butons expected to be a function')
	});



	it(`is_empty returns boolean`, async function() {

		const result = is_empty(instance)

		assert.equal(typeof result, 'boolean', 'is_empty expected boolean')
	});



	it(`instance id is set`, async function() {

		assert.isOk(instance.id, 'instance.id expected to be set')
		assert.equal(typeof instance.id, 'string', 'instance.id expected string')
	});



	it(`worker_path is set`, async function() {

		assert.isOk(instance.worker_path, 'worker_path expected to be set')
		assert.equal(typeof instance.worker_path, 'string', 'worker_path expected string')
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



describe(`COMPONENT_SECURITY_ACCESS SEARCH DATA OPERATIONS`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null



	it(`init → build → render (search mode)`, async function() {

		const options = {
			model			: 'component_security_access',
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



/**
* The permission tree is ~32k entries rendered lazily, so its search layer is a
* DOM-free module: filter_tree() answers the only question the renderer asks —
* which flat subset to draw (matches + their ancestor path). The fixture mirrors
* the REAL datalist shape, including the two facts a naive filter gets wrong:
*   - a tipo REPEATS (a section_group shared by several sections appears once per
*     section), so tipo is not a node identity;
*   - an entry can be UNREACHABLE (its area is denied), so it never paints and
*     must not be counted.
*/
describe(`COMPONENT_SECURITY_ACCESS TREE FILTER`, function() {

	const datalist = [
		{tipo:'areaA', section_tipo:'areaA', model:'area_root', label:'Catalogue', parent:'dd1'},
		{tipo:'secX', section_tipo:'secX', model:'section', label:'Coins', parent:'areaA'},
		{tipo:'grp1', section_tipo:'secX', model:'section_group', label:'General', parent:'secX'},
		{tipo:'comp1', section_tipo:'secX', model:'component_input_text', label:'Name field', parent:'grp1'},
		{tipo:'secY', section_tipo:'secY', model:'section', label:'Users', parent:'areaA'},
		{tipo:'grp1', section_tipo:'secY', model:'section_group', label:'General', parent:'secY'},
		{tipo:'comp1', section_tipo:'secY', model:'component_text_area', label:'Mail field', parent:'grp1'},
		{tipo:'areaB', section_tipo:'areaB', model:'area_root', label:'Tesauro', parent:'dd1'},
		{tipo:'secZ', section_tipo:'secZ', model:'section', label:'Dirección oculta', parent:'deniedArea'},
		{tipo:'comp9', section_tipo:'secZ', model:'component_input_text', label:'Hidden field', parent:'secZ'}
	]

	// entries kept, as `${section_tipo}/${tipo}`: tipo alone repeats on purpose
	const kept = (result) => result.items.map(el => `${el.section_tipo}/${el.tipo}`)
	const filtered = (query) => filter_tree(datalist, query)

	it('normalize_text folds case and diacritics', function() {
		assert.equal(normalize_text('España'), 'espana', 'expected diacritics stripped and lowercased')
		assert.equal(normalize_text(null), '', 'expected null to fold to empty string')
	})

	it('parse_query splits on whitespace and drops empties', function() {
		assert.deepEqual(parse_query('  Name  comp1 '), ['name','comp1'], 'expected trimmed tokens')
		assert.deepEqual(parse_query('   '), [], 'expected whitespace-only to yield no tokens')
	})

	it('an empty query means no filter', function() {
		assert.equal(filter_tree(datalist, ''), null, 'expected null (render the normal lazy tree)')
		assert.equal(filter_tree(datalist, '   '), null, 'expected whitespace-only to mean no filter')
	})

	it('matches by name, by tipo, and diacritic-insensitively', function() {
		assert.deepEqual(kept(filtered('users')).sort(), ['areaA/areaA','secY/secY'], 'expected the section + its area')
		assert.deepEqual(kept(filtered('secY')).sort(), ['areaA/areaA','secY/secY'], 'expected a section tipo match')
		assert.deepEqual(kept(filtered('direccion')), kept(filtered('Dirección')), 'expected the accent to be ignored')
		assert.deepEqual(kept(filtered('zzz')), [], 'expected a dead end to keep nothing')
	})

	it('keeps the ancestor path, in datalist order, and counts matches only', function() {
		const result = filtered('comp1')
		assert.equal(result.match_count, 2, 'expected BOTH occurrences of the repeated tipo to match')
		assert.equal(result.truncated, false, 'expected no truncation')
		assert.equal(result.matches.size, 2, 'expected the highlight set to hold the matches only')
		assert.deepEqual(
			kept(result),
			['areaA/areaA','secX/secX','secX/grp1','secX/comp1','secY/secY','secY/grp1','secY/comp1'],
			'expected original order, each occurrence with its OWN path'
		)
	})

	it('marks the matches, not the ancestors kept for their path', function() {
		// the entry objects are the highlight identity: a tipo would collide
		const result = filtered('name field')
		const marked = [...result.matches].map(el => `${el.section_tipo}/${el.tipo}`)
		assert.deepEqual(marked, ['secX/comp1'], 'expected ONE marked entry, the match itself')
		assert.equal(result.matches.has(result.items[0]), false, 'expected the root area NOT to be marked')
	})

	it('does not confuse two occurrences of the same tipo', function() {
		const result = filtered('mail field')
		assert.equal(result.match_count, 1, 'expected one entry')
		assert.deepEqual(
			kept(result),
			['areaA/areaA','secY/secY','secY/grp1','secY/comp1'],
			'expected the chain through secY, not the same-tipo chain of secX'
		)
	})

	it('tokens are ANDed and order-independent', function() {
		assert.deepEqual(kept(filtered('name field')).sort(), kept(filtered('field name')).sort(), 'expected order not to matter')
		assert.deepEqual(kept(filtered('users name')), [], 'expected tokens to have to match the SAME entry')
	})

	it('item_matches searches label and tipo, never the model', function() {
		const node = {tipo:'comp1', label:'Name field', model:'component_input_text'}
		assert.equal(item_matches(node, parse_query('component')), false, 'expected model NOT to be searched')
		assert.equal(item_matches(node, parse_query('comp1')), true, 'expected tipo to be searched')
	})

	it('caps the rendered matches and reports the real total', function() {
		const big = [{tipo:'root', section_tipo:'root', model:'area_root', label:'Root', parent:'dd1'}]
		for (let i = 0; i < MATCH_LIMIT + 5; i++) {
			big.push({tipo:'n'+i, section_tipo:'root', model:'component_input_text', label:'Item', parent:'root'})
		}
		const result = filter_tree(big, 'item')
		assert.equal(result.match_count, MATCH_LIMIT + 5, 'expected the REAL total in the counter')
		assert.equal(result.truncated, true, 'expected the truncated flag')
		assert.equal(
			result.items.filter(el => el.label==='Item').length,
			MATCH_LIMIT,
			'expected the rendered matches to stop at MATCH_LIMIT'
		)
		assert.equal(result.matches.size, MATCH_LIMIT, 'expected only the PAINTED matches to be marked')
	})

	it('an unreachable entry is neither painted nor counted', function() {
		// secZ/comp9 sit under deniedArea, which is not in the list: the tree starts
		// at parent==='dd1', so they can never paint — counting them would be a lie
		const result = filtered('hidden field')
		assert.equal(result.match_count, 0, 'expected the unreachable match not to be counted')
		assert.deepEqual(kept(result), [], 'expected nothing painted')
	})
})



describe(`COMPONENT_SECURITY_ACCESS TREE FILTER (DOM)`, function() {

	this.timeout(15000);

	let instance	= null
	let node		= null

	it(`renders the filter box and narrows the tree`, async function() {

		const options = {
			model			: 'component_security_access',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'tree_filter_' + Math.random()
		}

		instance = await get_instance(options)
		await instance.build(true)
		node = await instance.render()
		component_container.appendChild(node)

		const tree = node.querySelector('.tree_root')
		assert.isOk(tree, 'expected the tree ul')
		const filter_input = tree.querySelector('.tree_filter_input')
		assert.isOk(filter_input, 'expected the tree filter input')
		const clear_button = tree.querySelector('.tree_filter_clear')
		assert.isOk(clear_button, 'expected the clear button')

		// a component entry this filter can actually paint: query its own tipo and
		// keep the first candidate with a non-empty result. Tipos repeat in the real
		// datalist, so the assertion compares against what the filter resolved, not
		// against a hard-coded 1. Bounded to 25 probes: each one is a full scan.
		const datalist = instance.data.datalist || []
		const candidates = datalist
			.filter(el => el.tipo!==el.section_tipo && (el.model || '').startsWith('component_') && el.label)
			.slice(0, 25)
		let leaf = null
		let resolved = null
		for (const candidate of candidates) {
			const result = filter_tree(datalist, candidate.tipo)
			if (result && result.match_count > 0) {
				leaf = candidate
				resolved = result
				break
			}
		}
		assert.isOk(leaf, 'expected a component entry the filter can resolve')

		const root_nodes_before = tree.querySelectorAll('.li_item').length
		assert.isAbove(root_nodes_before, 0, 'expected the unfiltered tree to render its root nodes')
		assert.isTrue(clear_button.classList.contains('hide'), 'expected no clear button with an empty query')

		// filter by the node's own tipo
		filter_input.value = leaf.tipo
		filter_input.dispatchEvent(new Event('input'))

		assert.include(tree.textContent, leaf.tipo, 'expected the matched node rendered with its tipo')
		assert.include(
			tree.querySelector('.tree_filter_count').textContent,
			resolved.match_count + ' / ',
			'expected the counter to report what the filter resolved'
		)
		const marked = tree.querySelectorAll('.li_item.match')
		assert.equal(marked.length, resolved.matches.size, 'expected every painted match marked')
		assert.isAbove(marked.length, 0, 'expected at least one highlighted row')
		assert.include(marked[0].textContent, leaf.tipo, 'expected the highlight on the matched entry')
		assert.isFalse(clear_button.classList.contains('hide'), 'expected the clear button once a query is set')
		assert.isFalse(
			tree.querySelector('.tree_filter_count').classList.contains('hide'),
			'expected the match counter while filtering'
		)
		assert.isTrue(
			tree.querySelector('.tree_filter_status').getAttribute('role')==='status',
			'expected the filter status to be announced'
		)
		assert.isTrue(
			tree.querySelector('.tree_filter_status').textContent===''
			|| tree.querySelector('.tree_filter_status').classList.contains('hide'),
			'expected no dead-end notice for a match'
		)

		// a dead end says so instead of leaving a blank panel
		filter_input.value = 'zzz_no_such_label'
		filter_input.dispatchEvent(new Event('input'))
		assert.isFalse(
			tree.querySelector('.tree_filter_status').classList.contains('hide'),
			'expected an explicit no-matches notice'
		)

		// clearing restores the normal lazy tree
		clear_button.dispatchEvent(new MouseEvent('click', {bubbles:false}))
		assert.equal(filter_input.value, '', 'expected the query to be cleared')
		assert.equal(
			tree.querySelectorAll('.li_item').length,
			root_nodes_before,
			'expected the unfiltered tree back'
		)
		assert.isTrue(clear_button.classList.contains('hide'), 'expected the clear button hidden again')
	})

	it(`destroy after the tree filter test`, async function() {

		if (instance) {
			await instance.destroy(true)
		}

		assert.equal(instance.status, 'destroyed', 'status expected destroyed')

		// clean DOM
			while (component_container.firstChild) {
				component_container.removeChild(component_container.firstChild)
			}
	})
})



// @license-end
