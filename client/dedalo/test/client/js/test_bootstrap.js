// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
* TEST_BOOTSTRAP
* ES module, loaded after the classic mocha.js and BEFORE the module runners
* (js/index.js, js/frame_runner.js). Module scripts execute in document order,
* so the bdd interface (describe/it) and the global `assert` still exist before
* any test file is imported — the guarantee has not changed, only the mechanism.
* Externalized from inline <script> blocks to comply with the
* Content-Security-Policy (see root .htaccess script-src).
*
* WHY A MODULE (2026-08-03, chai 4 -> 6): chai 5 dropped the UMD browser bundle
* (`chai.js`) and ships ESM only. Its `index.js` is a SELF-CONTAINED bundle — no
* bare specifiers — so the browser loads it straight from the client-lib registry
* through the import map, with no bundler and no extra libs to register. The
* global `assert` is kept: ~88 test files use it, and they are not the reason
* for this change.
*/

import { assert } from '../../../lib/chai/index.js'

// early theme init — runs in <head> before the body paints to avoid a
// theme flash. Mirrors Dédalo's core/page/js/head-init.js convention:
// LIGHT is the default (no attribute); DARK is opt-in via data-theme="dark"
// and localStorage 'dedalo_theme' === 'dark'. frame.html passes ?theme=...;
// index.html falls back to the saved (app) preference.
;(function () {
	try {
		const params = new URLSearchParams(window.location.search)
		let theme = params.get('theme')
		if (theme !== 'light' && theme !== 'dark') {
			theme = localStorage.getItem('dedalo_theme') === 'dark' ? 'dark' : 'light'
		}
		if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
		else document.documentElement.removeAttribute('data-theme')
	} catch (e) {}
})()

mocha.setup({
	ui			: 'bdd',
	checkLeaks	: true,
	// asyncOnly disabled: the per-tool suites (test_tool_*) are SYNCHRONOUS
	// structural checks (module exports / prototype wiring), which mocha rejects
	// under async-only. The integration suites remain async and unaffected (they
	// return promises regardless of this flag). TS seam adaptation.
	asyncOnly	: false
})

window.assert = assert
