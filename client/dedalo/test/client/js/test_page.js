// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/


import {get_instance} from '../../../core/common/js/instances.js'
import {render_debug_info_bar} from '../../../core/menu/js/view_default_edit_menu.js'
import {select_accessible_name} from './a11y_surfaces.js'



/**
* PAGE TEST
* Builds and renders the page shell (the `page` instance with its menu) and
* asserts the rendered wrapper. Until 2026-09-02 this file was ONE `async
* describe` with no `it()`: Mocha never awaits a describe callback, so its
* awaits floated, the frame reported zero tests and the card was a PASS that
* could never go red (GATE-12). Registration happens synchronously here; the
* async work lives in `before`, where Mocha DOES await it.
*/
describe("PAGE TEST", function() {

	const container = document.getElementById('content')

	let page = null
	let node = null
	let data_lang_selector_flag

	before(async function() {
		// the menu's data-lang selector renders only when the installation exposes
		// it: force it on so its accessible name is gated on every suite DB
		data_lang_selector_flag = page_globals.dedalo_data_lang_selector
		page_globals.dedalo_data_lang_selector = true
		page = await get_instance({
			model	: 'page',
			menu	: true
		})
		await page.build(true)
		node = await page.render()
		container.appendChild(node)
	})

	after(function() {
		page_globals.dedalo_data_lang_selector = data_lang_selector_flag
	})

	it('builds a page instance with no page-level error', function() {
		assert.isObject(page, 'page instance')
		assert.equal(page.model, 'page')
		assert.isNull(page_globals.page_error, 'a page-level ApiError leaked into the shell build')
	})

	it('the debug bar never prints a missing build as "null" (campaign 3 C3-46)', function() {
		// a dev checkout's dedalo_build is null (WC-2026-08-23-build-provenance)
		const text = (info_data) => render_debug_info_bar({data : {info_data}})
			.querySelector('.dedalo_version').textContent
		const dev = text({dedalo_version : '7.0.0-dev', dedalo_build : null})
		assert.equal(dev, 'Code v. 7.0.0-dev')
		assert.notInclude(dev, 'null')
		// CONTROL: a release's build date is shown
		assert.equal(
			text({dedalo_version : '7.0.0', dedalo_build : '2026-10-13T10:00:00+02:00'}),
			'Code v. 7.0.0 2026-10-13T10:00:00+02:00'
		)
	})

	it('every menu <select> has an accessible name (WCAG 4.1.2, axe select-name)', async function() {
		// the menu renders into the shell asynchronously
		let selects = []
		for (let i = 0; i < 100; i++) {
			selects = [...node.querySelectorAll('.menu select')]
			if (selects.some(s => s.name==='dedalo_data_lang')) break
			await new Promise(r => setTimeout(r, 50))
		}
		const names = selects.map(s => s.name)
		assert.include(names, 'dedalo_application_langs', 'the interface lang selector renders')
		assert.include(names, 'dedalo_data_lang', 'the data lang selector renders')
		for (const select of selects) {
			assert.notStrictEqual(select_accessible_name(select), '', `menu select '${select.name}' is unnamed`)
		}
		const by_name = (n) => select_accessible_name(selects.find(s => s.name===n))
		assert.notStrictEqual(
			by_name('dedalo_application_langs'),
			by_name('dedalo_data_lang'),
			'the two lang selectors are named apart'
		)
	})

	it('renders the wrapper into the content container', function() {
		assert.instanceOf(node, Element)
		assert.isTrue(node.classList.contains('wrapper'), 'div.wrapper is the page shell (render_page.edit)')
		assert.strictEqual(node.parentNode, container)
		assert.isTrue(node.childElementCount > 0, 'the wrapper holds content_data')
	})
})



// @license-end
