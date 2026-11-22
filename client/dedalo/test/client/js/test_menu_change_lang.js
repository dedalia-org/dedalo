// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/

/**
* MENU LANGUAGE SELECTORS — the data-language options and the refusal path
* (T2 rulings re-review item 2; WC-2026-11-22-change-lang-declared-data-lang).
*
* 1. The DATA-language selector offers EXACTLY the server's `dedalo_data_langs`
*    (the set change_lang accepts: the installation's data languages, never the
*    lg-nolan storage slot). Before, it was built from the INTERFACE languages —
*    on the suite installation a different set (8 interface vs 12 data
*    languages), so it hid data languages the server accepts.
* 2. change_lang does NOT reload the page when the server REFUSES (ok:false):
*    the refusal is published as 'api_error' (the error policy renders it) and a
*    reload would wipe it before anyone read it. A stored change still reloads.
*
* Against the SUITE server (real page_globals, real change_lang). Nothing is
* stored: the refused value is refused, the accepted one is the session's
* current data language (a no-op write).
*/

import {event_manager} from '../../../core/common/js/event_manager.js'
import {menu} from '../../../core/menu/js/menu.js'
import {change_lang, data_lang_options} from '../../../core/menu/js/view_default_edit_menu.js'



describe('menu language selectors (re-review item 2)', function() {

	this.timeout(20000)

	it('the data-language selector offers exactly page_globals.dedalo_data_langs', function() {
		const served = page_globals.dedalo_data_langs
		assert.isArray(served, 'the server serves dedalo_data_langs')
		assert.isAbove(served.length, 0)
		const options = data_lang_options(page_globals, 'data')
		assert.deepEqual(options.map(item => item.value), served.map(item => item.value))
		assert.deepEqual(options.map(item => item.label), served.map(item => 'data: ' + item.label))
		assert.notInclude(options.map(item => item.value), 'lg-nolan', 'the storage slot is never offered')
		// FLOOR: on the suite installation the two sets DIFFER — so building the data
		// selector from the interface languages is observably wrong here.
		const application = (page_globals.dedalo_application_langs || []).map(item => item.value)
		const data_only = served.map(item => item.value).filter(value => !application.includes(value))
		assert.isAbove(data_only.length, 0, 'a data language that is not an interface language')
	})

	it('a REFUSED change does not reload; the refusal is published', async function() {
		const published = []
		const token = event_manager.subscribe('api_error', (api_error) => published.push(api_error))
		let reloads = 0
		try {
			const stored = await change_lang({
				lang_type	: 'dedalo_data_lang',
				lang_value	: 'lg-zzzq', // grammar-valid, not a data language of the installation
				self		: {change_lang: menu.prototype.change_lang},
				reload		: () => { reloads++ }
			})
			assert.strictEqual(stored, false)
		} finally {
			event_manager.unsubscribe(token)
		}
		assert.strictEqual(reloads, 0, 'no reload on ok:false')
		assert.include(published.map(api_error => api_error.code), 'request.invalid_options')
		const main = document.getElementById('main')
		if (main) {
			assert.isFalse(main.classList.contains('loading'), 'loading state cleared')
		}
	})

	it('a STORED change reloads (control)', async function() {
		let reloads = 0
		const stored = await change_lang({
			lang_type	: 'dedalo_data_lang',
			lang_value	: page_globals.dedalo_data_lang, // the session's own: a no-op write
			self		: {change_lang: menu.prototype.change_lang},
			reload		: () => { reloads++ }
		})
		assert.strictEqual(stored, true)
		assert.strictEqual(reloads, 1)
	})
})



// @license-end
