// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
* FRAME_RUNNER
* Runs inside the iframe. Loads test files and reports results to parent.
* Any setup failure (bad area, missing login, import/runtime error) is reported
* to the parent as `test_error` so a suite never silently hangs the queue.
*/

import {data_manager} from '../../../core/common/js/data_manager.js'
import {set_environment} from '../../../core/common/js/common.js'
import {load_labels} from '../../../core/common/js/labels.js'
import {url_vars_to_object} from '../../../core/common/js/utils/index.js'
import {response_data} from '../../../core/common/js/api_error.js'

const url_vars = url_vars_to_object(window.location.search)
const area = url_vars.area

// report_error: notify the parent so the card fails instead of hanging
function report_error(err) {
	window.parent.postMessage({
		type	: 'test_error',
		area	: area || null,
		error	: String((err && err.message) || err)
	}, '*')
}

if (!area) {
	report_error('No test area specified')
	throw 'No test area specified'
}

// inherit theme from URL — keep the chrome and the embedded Dédalo
// components (styled by main.css via data-theme) in the same theme.
// Dédalo convention: light = no attribute; dark = data-theme="dark".
if (url_vars.theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
else document.documentElement.removeAttribute('data-theme')

let ready = false
try {
	await (async () => {
		window.page_globals = {
			page_error: null,
			request_message: null
		}
		window.get_label = {}
		window.SHOW_DEBUG = false
		window.DEVELOPMENT_SERVER = false
		window.DEDALO_API_URL = '../../core/api/v1/json/'
		// app-global the full page injects server-side; a component may read it
		// as a bare global fallback, so stub it to avoid a ReferenceError
		window.PHP_VERSION = window.PHP_VERSION || ''

		const rqo = {
			action: 'get_environment',
			prevent_lock: true
		}
		const api_response = await data_manager.request({ body: rqo })
		set_environment(response_data(api_response))
		// labels: their own versioned resource (WC-2026-11-07-labels-separate-resource)
		await load_labels(page_globals.dedalo_application_lang, page_globals.labels_version)
	})()

	if (page_globals.is_logged !== true) {
		// render the login form and report so the parent does not wait forever
		const module = await import('../../../core/common/js/instances.js')
		const instance = await module.get_instance({
			model: 'login',
			tipo: 'dd229',
			mode: 'edit',
			lang: page_globals.dedalo_application_lang
		})
		await instance.build(true)
		const wrapper = await instance.render()
		document.body.appendChild(wrapper)
		report_error('Login is required')
	} else {
		// load test file
		await import(`./${area}.js`)
		ready = true
	}
} catch (err) {
	report_error(err)
}

if (ready) {
	// run mocha
	mocha.checkLeaks(false)
	mocha.setup({
		globals: []
	})

	const runner = mocha.run()

	// failures: the WHY of a red suite. Without it a failing suite is opaque all
	// the way out to the terminal (the parent only ever saw counters), so the
	// reason had to be re-discovered by hand in a browser. Collected here because
	// this is the only place the mocha Error object exists.
	const failures = []

	runner.on('test', function(test) {
		window.parent.postMessage({ type: 'test_start', title: test.title }, '*')
	})

	runner.on('fail', function(test, err) {
		failures.push({
			// full title = "suite > test", the name you re-run with
			title	: (test && (test.fullTitle ? test.fullTitle() : test.title)) || '(unknown test)',
			message	: String((err && err.message) || err),
			// a few frames only: this crosses a postMessage boundary, and the deep
			// tail is mocha's own machinery
			stack	: String((err && err.stack) || '').split('\n').slice(1, 5).join('\n')
		})
	})

	runner.on('end', function() {
		window.parent.postMessage({
			type	: 'test_end',
			area	: area,
			stats	: {
				// tests: how many mocha tests REGISTERED and ran. The parent reds a
				// suite that reports zero — a file that imports cleanly and
				// registers nothing has `failures === 0` and used to be a PASS
				// (GATE-12). Sent explicitly, never derived from pass+fail, so the
				// headless runner can floor the mocha TEST count, not the card count.
				tests	: runner.stats.tests,
				pass	: runner.stats.passes,
				fail	: runner.stats.failures,
				// pending: mocha counts a pending test (it.skip, a callback-less
				// it(), this.skip()) INSIDE `tests`, so the parent subtracts this
				// to know how many tests RAN — a suite whose tests are all pending
				// reports N tests and ran none (GATE-12, the all-pending variant).
				pending	: runner.stats.pending
			},
			failures : failures
		}, '*')
	})
}

// listen for theme changes from parent
window.addEventListener('message', function(e) {
	if (e.data && e.data.type === 'theme') {
		if (e.data.light) document.documentElement.removeAttribute('data-theme')
		else document.documentElement.setAttribute('data-theme', 'dark')
	}
})

// @license-end
