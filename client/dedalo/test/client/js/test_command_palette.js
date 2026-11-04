// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, beforeEach, assert, page_globals, get_label, document, window, localStorage, KeyboardEvent, Event */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_COMMAND_PALETTE
 * The application-wide ⌘K palette (core/common/js/command_palette.js): one box
 * that jumps to a section or opens the current section's tools.
 *
 * Backend-free: a FAKE page (a menu instance with a tree_datalist + a section
 * instance with tools) is bound through init_command_palette, the same door
 * page.add_events uses. Item actions are observed by replacing them, so no
 * navigation or tool opening happens. Recents are written under this run's
 * user key and cleared after.
 */

import {
	add_palette_provider,
	build_items,
	close_command_palette,
	fold,
	get_recent,
	init_command_palette,
	open_command_palette,
	push_recent
} from '../../../core/common/js/command_palette.js'
import {event_manager} from '../../../core/common/js/event_manager.js'



const DATALIST = [
	{ tipo : 'zz_area', parent : 'dd1', model : 'area', label : 'Resources' },
	{ tipo : 'zz_image', parent : 'zz_area', model : 'section', label : 'Image' },
	{ tipo : 'zz_av', parent : 'zz_area', model : 'section', label : 'Audiovisual' },
	{ tipo : 'zz_proxy', parent : 'zz_area', model : 'section', label : '<mark>Documentos</mark>', config : { swap_tipo : 'zz_real' } }
]

const fake_page = (tools=[]) => ({
	ar_instances : [
		{ model : 'menu', tools : [{ name : 'tool_user_admin', label : 'User admin' }], data : { tree_datalist : DATALIST } },
		{ model : 'section', tipo : 'zz_image', label : 'Image', tools }
	]
})

const recent_key = () => 'dedalo_palette_recent_' + (page_globals.user_id ?? '')

const visible_rows = () => [...document.querySelectorAll('.command_palette_list .p_item')]
const press = (node, key, extra={}) => {
	node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles : true, cancelable : true, ...extra }))
}
const input = () => document.querySelector('.command_palette_input')
const is_open = () => document.querySelector('.command_palette_backdrop')?.classList.contains('open') === true



describe('command palette (⌘K)', function () {

	let saved_recent = null
	before(function () {
		saved_recent = localStorage.getItem(recent_key())
	})
	after(function () {
		close_command_palette(false)
		if (saved_recent===null) {
			localStorage.removeItem(recent_key())
		}else{
			localStorage.setItem(recent_key(), saved_recent)
		}
	})
	beforeEach(function () {
		localStorage.removeItem(recent_key())
		window.modal = undefined
		init_command_palette(fake_page())
	})

	it('fold ignores case and accents', function () {
		assert.strictEqual(fold('Àudiovisual Ñ'), 'audiovisual n')
	})

	it('lists the section tools (not the menu\'s) before the sections, tool_identify gated', function () {
		const saved_ai = page_globals.ai_capabilities
		page_globals.ai_capabilities = { identify : false }
		try {
			init_command_palette(fake_page([
				{ name : 'tool_diffusion', label : 'Diffusion' },
				{ name : 'tool_identify', label : 'Identify' }
			]))
			const labels = build_items().map(it => it.label)
			assert.deepEqual(labels.slice(0, 1), ['Diffusion'])
			assert.notInclude(labels, 'Identify')
			assert.notInclude(labels, 'User admin', 'the menu instance tools are not the section tools')
			assert.includeMembers(labels, ['Resources', 'Image', 'Audiovisual', 'Documentos'])
		} finally {
			page_globals.ai_capabilities = saved_ai
		}
	})

	it('menu labels lose <mark> but keep the untranslated flag', function () {
		const it_doc = build_items().find(it => it.label==='Documentos')
		assert.strictEqual(it_doc.css, 'mark')
		assert.strictEqual(it_doc.hint, 'Resources')
	})

	it('records menu navigations as recents (swap_tipo resolved), newest first, stale ignored', function () {
		event_manager.publish('user_navigation', { source : { tipo : 'zz_av', mode : 'list' } })
		event_manager.publish('user_navigation', { source : { tipo : 'zz_real', mode : 'list' } })
		event_manager.publish('user_navigation', { source : { tipo : 'not_in_menu', mode : 'list' } })
		assert.deepEqual(get_recent(), ['zz_proxy', 'zz_av'])

		push_recent('gone_tipo') // e.g. permission revoked since
		const recent = build_items().filter(it => it.group===(get_label.recent || 'Recent')).map(it => it.label)
		assert.deepEqual(recent, ['Documentos', 'Audiovisual'])
	})

	it('caps recents at 8 without duplicates', function () {
		for (let i = 0; i < 10; i++) { push_recent('t' + i) }
		push_recent('t5')
		const list = get_recent()
		assert.strictEqual(list.length, 8)
		assert.strictEqual(list[0], 't5')
		assert.strictEqual(list.filter(t => t==='t5').length, 1)
	})

	it('filters accent-insensitively, Enter runs the selected item, focus returns on Esc', function () {
		let ran = null
		const remove = add_palette_provider(() => [{ group : 'Zz', label : 'Ñandú widget', action : () => { ran = 'nandu' } }])
		const opener = document.createElement('button')
		document.body.appendChild(opener)
		try {
			opener.focus()
			assert.isTrue(open_command_palette())
			assert.isTrue(is_open())
			assert.strictEqual(visible_rows()[0].textContent.includes('Ñandú widget'), true, 'providers come first')

			input().value = 'nandu'
			input().dispatchEvent(new Event('input'))
			assert.strictEqual(visible_rows().length, 1)
			press(input(), 'Enter')
			assert.strictEqual(ran, 'nandu')
			assert.isFalse(is_open())
			assert.notStrictEqual(document.activeElement, input(), 'the hidden input does not keep focus')

			opener.focus()
			open_command_palette()
			input().value = 'zzzz no match'
			input().dispatchEvent(new Event('input'))
			assert.strictEqual(visible_rows().length, 0)
			assert.isNotNull(document.querySelector('.command_palette_list .p_empty'))
			press(input(), 'Escape')
			assert.isFalse(is_open())
			assert.strictEqual(document.activeElement, opener, 'focus goes back')
		} finally {
			remove()
			opener.remove()
		}
	})

	it('arrow keys move the selection and wrap', function () {
		open_command_palette()
		const rows = visible_rows()
		assert.isTrue(rows[0].classList.contains('sel'))
		press(input(), 'ArrowDown')
		assert.isTrue(rows[1].classList.contains('sel'))
		press(input(), 'ArrowUp')
		press(input(), 'ArrowUp')
		assert.isTrue(rows[rows.length - 1].classList.contains('sel'))
		press(input(), 'k', { ctrlKey : true })
		assert.isFalse(is_open(), 'Ctrl+K inside the box closes it')
	})

	it('a removed provider no longer lists', function () {
		const remove = add_palette_provider(() => [{ label : 'Temporary', action : () => {} }])
		remove()
		assert.notInclude(build_items().map(it => it.label), 'Temporary')
	})

	it('never opens over a modal', function () {
		window.modal = {}
		try {
			assert.isFalse(open_command_palette())
			assert.isFalse(is_open())
		} finally {
			window.modal = undefined
		}
	})
})



// @license-end
