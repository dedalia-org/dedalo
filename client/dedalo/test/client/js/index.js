// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
* UNIT_TEST
* To check Dédalo elements basic functionalities
*/

// imports
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {set_environment} from '../../../core/common/js/common.js'
	import {load_labels} from '../../../core/common/js/labels.js'
	import {url_vars_to_object} from '../../../core/common/js/utils/index.js'
	import {response_data} from '../../../core/common/js/api_error.js'
	import {card_state_from_message, apply_card_state, count_run, reset_run_count} from './card_state.js'

// check url vars
	const url_vars = url_vars_to_object(window.location.search);

// page start
	await ( async () => {

		window.page_globals = {
			page_error : null,
			request_message : null
		}
		window.get_label = {}
		window.SHOW_DEBUG = false
		window.DEVELOPMENT_SERVER = false
		window.DEDALO_API_URL = '../../core/api/v1/json/'
		// app-global the full page injects server-side; a component may read it
		// as a bare global fallback, so stub it to avoid a ReferenceError
		window.PHP_VERSION = window.PHP_VERSION || ''

		const rqo = {
			action			: 'get_environment',
			prevent_lock	: true
		}
		const api_response = await data_manager.request({
			body : rqo
		});
		set_environment(response_data(api_response))
		// labels: their own versioned resource (WC-2026-11-07-labels-separate-resource)
		await load_labels(page_globals.dedalo_application_lang, page_globals.labels_version)
	})()

// login check
	if (page_globals.is_logged!==true) {

		import ('../../../core/common/js/instances.js')
		.then(async function(module){
			const instance = await module.get_instance({
				model	: 'login',
				tipo	: 'dd229',
				mode	: 'edit',
				lang	: page_globals.dedalo_application_lang
			})
			await instance.build(true);
			const wrapper = await instance.render()
			document.body.appendChild(wrapper)
		})
		throw 'Login is required';
	}

// load sidebar
	const list_module = await import('./list.js')
	const { test_cards, mark_test_status } = list_module

// iframe management
	const test_frame = document.getElementById('test_frame')
	const placeholder = document.getElementById('main_placeholder')
	let run_all_queue = []
	let run_all_index = 0
	let run_all_active = false

	// single in-flight test bookkeeping
	let active_handler = null
	let active_watchdog = null
	const WATCHDOG_MS = 120000 // force-fail a suite that never reports back

	// find_card: the sidebar card for a suite name (cards are keyed lower-case)
	function find_card(test_name) {
		const key = test_name.toLowerCase()
		return test_cards.find(card => card.dataset.testName === key) || null
	}

	// settle_card: park the page-side verdict of ONE suite on its card. The
	// DECISION is card_state.js (pure, no DOM — proved in bun by
	// test/unit/client_gate_inventory_tripwire over the frame's own messages,
	// through the runner's scrape and verdict); this only applies it. A suite is
	// run ONCE per queue pass (the silent retry was deleted, GATE-11), so a
	// card's reason is always the reason of the run that produced its dot — a
	// manual re-run replaces it wholesale.
	function settle_card(test_name, state, on_complete) {
		apply_card_state(find_card(test_name), state)
		finish_active(test_name, state.status, on_complete)
	}

	// clear_active: detach the current message listener and watchdog
	function clear_active() {
		if (active_handler) {
			window.removeEventListener('message', active_handler)
			active_handler = null
		}
		if (active_watchdog) {
			clearTimeout(active_watchdog)
			active_watchdog = null
		}
	}

	// finish_active: settle the running test and advance the queue
	function finish_active(test_name, status, on_complete) {
		clear_active()
		mark_test_status(test_name, status)
		if (typeof on_complete === 'function') {
			on_complete()
		}
	}

// load_test: load a test in the iframe
window.load_test = function(area, model, test_name, on_complete) {
	// drop any previous in-flight listener/watchdog (e.g. user clicks a new test mid-run)
	clear_active()

	// hide placeholder
	if (placeholder) placeholder.style.display = 'none'

	// show iframe
	test_frame.style.display = 'block'

	// mark as running
	mark_test_status(test_name, 'running')
	count_run(find_card(test_name))

	// update url
	const params = new URLSearchParams()
	params.set('area', area)
	if (model) params.set('model', model)
	window.history.replaceState({}, '', `./?${params.toString()}`)

	// set iframe src - fresh page load each time
	const is_dark = document.documentElement.getAttribute('data-theme') === 'dark'
	test_frame.src = `./frame.html?area=${area}${model ? '&model=' + model : ''}&theme=${is_dark ? 'dark' : 'light'}`

	// listen for iframe messages
	active_handler = function(e) {
		// only accept messages coming from the test iframe
		if (e.source !== test_frame.contentWindow) return
		if (!e.data || !e.data.type) return

		if (e.data.type === 'test_start') {
			mark_test_status(test_name, 'running')
		}
		else {
			// test_end / test_error: the verdict is card_state.js's, over the
			// message EXACTLY as posted — nothing here reads a count.
			const state = card_state_from_message(e.data)
			if (state) settle_card(test_name, state, on_complete)
		}
	}
	window.addEventListener('message', active_handler)

	// watchdog: never let a stuck iframe stall the queue
	active_watchdog = setTimeout(function() {
		settle_card(test_name, card_state_from_message({ type: 'watchdog', ms: WATCHDOG_MS }), on_complete)
	}, WATCHDOG_MS)
}

// run all
	const run_all_btn = document.getElementById('test_run_all')
	// READINESS. index.html ships the button DISABLED; it is enabled here, after
	// list.js populated the cards and the click listener is attached. That makes
	// `#test_run_all:not([disabled])` a real signal: the headless runner used to
	// wait on it while nothing ever disabled the button, so an import-time throw
	// anywhere in this file's chain left a listener-less button that matched
	// from first paint, and the run reported green over zero suites (GATE-10).
	if (run_all_btn) {
		run_all_btn.addEventListener('click', () => {
			if (run_all_btn.disabled) return
			// deferred suites are visible + manually runnable but excluded from the
			// `run all` gate (they are known-not-green yet; see test_registry.js).
			const visible_cards = test_cards.filter(c => c.style.display !== 'none' && !c.dataset.deferred)
			if (visible_cards.length === 0) return

			run_all_btn.disabled = true
			run_all_btn.querySelector('.run_all_text').textContent = 'running…'
			// A fresh run counts its own loads only (card_state.js count_run).
			for (const card of visible_cards) reset_run_count(card)
			run_all_queue = visible_cards
			run_all_index = 0
			run_all_active = true

			function run_next() {
				if (run_all_index >= run_all_queue.length) {
					run_all_btn.disabled = false
					run_all_btn.querySelector('.run_all_text').textContent = 'run all'
					run_all_active = false
					return
				}
				const card = run_all_queue[run_all_index]
				run_all_index++
				card.classList.add('test_card_active')
				const area = card.dataset.area
				const model = card.dataset.model || null
				const test_name = card.dataset.testName

				// NO RETRY. A failed suite used to be re-run once, its first
				// attempt's reasons deleted and the retry's PASS reported — so the
				// headline "132/132" could not tell a stable green from a suite
				// failing every other run (GATE-11). A flaky failure is simply RED
				// and gets fixed; the headless runner additionally reds any card
				// whose `data-run-count` reads more than 1 (every frame load
				// bumps it), so the mechanism cannot come back quietly under any
				// name.
				const on_done = () => {
					card.classList.remove('test_card_active')
					setTimeout(run_next, 200)
				}

				window.load_test(area, model, test_name, on_done)
			}

			run_next()
		})
		if (test_cards.length > 0) {
			run_all_btn.disabled = false
		}
	}

// theme toggle
	const theme_toggle = document.getElementById('theme_toggle')
	const icon_moon = theme_toggle?.querySelector('.theme_icon_moon')
	const icon_sun = theme_toggle?.querySelector('.theme_icon_sun')

	// Theme — synced to Dédalo's selection (core/page/js/theme.js convention):
	// key 'dedalo_theme'; LIGHT is the default (no attribute, key removed);
	// DARK = data-theme="dark" + stored 'dark'. Served same-origin as the app,
	// so reading/writing this key reflects (and updates) the user's app theme.
	function set_theme(light) {
		if (light) {
			document.documentElement.removeAttribute('data-theme')
			try { localStorage.removeItem('dedalo_theme') } catch(e) {}
		} else {
			document.documentElement.setAttribute('data-theme', 'dark')
			try { localStorage.setItem('dedalo_theme', 'dark') } catch(e) {}
		}
		// icon: light shows moon (→ switch to dark), dark shows sun (→ switch to light)
		if (icon_moon) icon_moon.style.display = light ? 'block' : 'none'
		if (icon_sun) icon_sun.style.display = light ? 'none' : 'block'
		// sync iframe
		if (test_frame.contentWindow) {
			test_frame.contentWindow.postMessage({ type: 'theme', light: light }, '*')
		}
	}

	// restore: light is the default; dark only when the app stored it explicitly
	const saved = localStorage.getItem('dedalo_theme')
	set_theme(saved !== 'dark')

	if (theme_toggle) {
		theme_toggle.addEventListener('click', () => {
			// flip: if currently dark, switch to light (and vice-versa)
			set_theme(document.documentElement.getAttribute('data-theme') === 'dark')
		})
	}

// if url has area, auto-load it
	if (url_vars.area) {
		const area = url_vars.area
		const model = url_vars.model || null
		const test_name = model || area

		for (const card of test_cards) {
			if (card.dataset.testName === test_name.toLowerCase()) {
				card.classList.add('test_card_active')
				break
			}
		}

		setTimeout(() => {
			window.load_test(area, model, test_name)
		}, 100)
	}

// @license-end
