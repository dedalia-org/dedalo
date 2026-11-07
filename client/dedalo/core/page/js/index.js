// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/

/**
* PAGE/INDEX
* Application bootstrap entry point for the Dédalo page shell.
*
* This module is the first JS file evaluated when the browser loads the Dédalo
* application. It is responsible for:
*   1. Initialising the `window.page_globals` namespace and CSRF-token slot.
*   2. Attaching application-level event listeners via `events_init`.
*   3. Creating, building (API `start` call), and rendering the singleton `page`
*      instance into the `#main` DOM container.
*   4. Mounting a passive scroll listener that throttles work through
*      `requestAnimationFrame` to keep the main thread free during fast scrolls.
*
* No exports — this module is loaded purely for its side-effects.
* Import order matters: `page.js` and `event_manager.js` are side-effect-only
* imports that must execute before `get_instance` is called so their module-scope
* registrations are available.
*/

const t0 = performance.now()

// error capture. MUST stay the first import: installs the window-level
// error/unhandledrejection listeners before any other module evaluates, so
// window.dedalo_js_errors (read by tool_error_report) sees the whole page life.
	import '../../common/js/error_capture.js'

// page instance imports
	import '../js/page.js'
	import '../../common/js/event_manager.js'
	import {events_init} from '../../common/js/events.js'
	import {get_instance} from '../../common/js/instances.js'

/**
* MAIN_CSS
* Keeps the page's main stylesheet on the version the SERVER says is current.
*
* The client tree is served by the institution's web server, whose cache headers
* Dédalo does not control: without `Cache-Control: no-cache` a browser keeps
* main.css — and index.html itself — heuristically fresh for days after a code
* update, so no URL written into a static file can be trusted. The `start`
* response is fresh on every install, and carries page_globals.css_version (a
* content hash of the client stylesheets, core/api/dedalo_files.ts
* clientCssVersion). A URL built from it changes exactly when the bytes do.
*
* Lives HERE, not in a module of its own: the boot graph's module count is a
* shrink-only budget (page_load_budget_native).
*
* Two halves, one storage key:
*   1. head-init.js (classic, synchronous, in <head>) writes
*      `<link id="main_css" href="css/main.css?v=<last version>">` PARSER-INSERTED,
*      so first paint is render-blocked exactly as by a static link.
*   2. sync_main_css (below, called by the boot after `start`, before render)
*      swaps to the server's version when it differs, and remembers it.
* Steady state: one stylesheet request, from cache. After an update: the new URL
* is fetched once, before the page renders.
*/



// string storage key — head-init.js reads the SAME literal (gate:
// test/unit/css_version_native.test.ts)
const MAIN_CSS_KEY = 'dedalo_css_version'

// a css_version is 16 lowercase hex (clientCssVersion); anything else is ignored
const VERSION_RE = /^[0-9a-f]{16}$/

// ceiling for the new sheet's load: past it the page renders with what it has
const LOAD_TIMEOUT_MS = 15000



/**
* MAIN_CSS_URL
* Absolute URL of main.css at `version` (no query when null).
* @param {string|null} version
* @returns {string}
*/
const main_css_url = (version) => {

	const url = new URL('../css/main.css', import.meta.url)
	if (version) {
		url.searchParams.set('v', version)
	}
	return url.href
}//end main_css_url



/**
* SYNC_MAIN_CSS
* Make #main_css the server's version. Resolves when the right sheet is applied
* (or the attempt failed — never rejects: a stylesheet must not stop the boot).
* @param {string|null|undefined} version - page_globals.css_version
* @returns {Promise<boolean>} true when a new sheet was loaded
*/
const sync_main_css = async (version) => {

	const valid		= typeof version==='string' && VERSION_RE.test(version)
	// the written sheet — or, from a stale index.html of before head-init.js, its
	// id-less static link: replaced in place, never left after (and so over) the new one
	const current	= document.getElementById('main_css')
		|| document.head.querySelector('link[rel="stylesheet"][href*="/core/page/css/main.css"]')

	// already right — or no version to go by and a sheet already present
	if (current && (valid ? current.dataset.version===version : true)) {
		if (valid) remember(version)
		return false
	}

	const link = document.createElement('link')
	link.id				= 'main_css'
	link.rel			= 'stylesheet'
	link.href			= main_css_url(valid ? version : null)
	if (valid) {
		link.dataset.version = version
	}

	const loaded = new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)
		link.onload		= () => { clearTimeout(timer); resolve(true) }
		link.onerror	= () => { clearTimeout(timer); resolve(false) }
	})

	// main.css comes FIRST in the cascade: tool sheets and the ontology
	// #elements_style_sheet must keep overriding it
	if (current) {
		current.removeAttribute('id')
		current.after(link)
	}else{
		document.head.prepend(link)
	}

	const ok = await loaded
	if (ok) {
		if (current) current.remove()
		if (valid) remember(version)
	}else{
		console.error('[main_css] failed to load', link.href)
		if (current) {
			// keep the old sheet: stale styles beat an unstyled page
			link.remove()
			current.id = 'main_css'
		}
	}

	return ok
}//end sync_main_css



/**
* REMEMBER
* Store the version head-init.js writes on the next page load.
* @param {string} version
* @returns {void}
*/
const remember = (version) => {
	try {
		localStorage.setItem(MAIN_CSS_KEY, version)
	} catch (_) {
		// storage blocked: every boot then loads the sheet after `start`
	}
}//end remember



/**
* PAGE START
* Immediately-invoked async IIFE that orchestrates the entire application boot
* sequence. Errors at any stage (network failure, missing DOM node, render
* failure) are caught and displayed as a plain-text error message in #main so
* the user sees something actionable rather than a blank screen.
*
* Boot sequence:
*   1. Initialise `window.page_globals`, `window.get_label`, and debug flags.
*   2. Attach global event listeners (save, visibilitychange).
*   3. Inject a "Starting…" placeholder into #main while the API call is in flight.
*   4. Retrieve (or create) the `page` instance via the shared instance registry.
*   5. Call `page_instance.build(true)` to perform the `start` API request and
*      populate the instance's context/data.
*   6. Call `page_instance.render()` to produce the full application DOM tree.
*   7. Swap the placeholder in #main for the rendered tree and reveal the shell.
*/
( async () => {

	try {

		// page_globals. Set basic properties
			window.page_globals = {
				// THE page-level failure: one ApiError, set by error_dispatch /
				// page.build and rendered by render_api_error.render_error_panel
				page_error : null,
				// API response last message
				request_message : null,
				// SEC-008: CSRF token captured from API responses; injected into
				// the X-Dedalo-Csrf-Token header by data_manager.request on every
				// non-bootstrap call. Initialised to null so the very first
				// `start` request goes out without a header (the server exempts
				// `start` from CSRF enforcement).
				csrf_token : null
			}
			window.get_label = {}
			window.SHOW_DEBUG = false
			window.DEVELOPMENT_SERVER = false

		// main events init (visibility change, save,..)
			events_init()

		// main CSS add loading
			const main = document.getElementById('main')
			if (!main) {
				console.warn('Missing #main element. Aborting bootstrap.')
				return
			}
			const starting_node = document.createElement('div')
			starting_node.className = 'starting blink'
			starting_node.textContent = 'Starting.. Please wait.'
			main.appendChild(starting_node)

		// page instance init
		// get_instance returns the cached singleton when called with model:'page';
		// on first call it dynamically imports page.js and constructs the instance.
			const page_instance = await get_instance({
				model : 'page'
			});

		// page instance build (exec a start request to API)
		// Passing `true` forces a fresh build even if a cached context exists.
		// This call fires the `start` API action that authenticates the session
		// and downloads the full application context (sections, labels, toolbars…).
			await page_instance.build(true)

		// main stylesheet. On the server's css_version BEFORE anything renders: the
		// sheet head-init.js wrote is the one the LAST boot saw, and a code update
		// since then must not paint with it (see MAIN_CSS above). Also runs when build
		// failed (no css_version): the error panel still gets a sheet.
			await sync_main_css(window.page_globals?.css_version)

		// page instance render
		// render() resolves with the top-level HTMLElement containing the complete
		// application shell. A null return means an unrecoverable render error.
			const wrapper_page = await page_instance.render()
			if (!wrapper_page) {
				console.error('page render returned no node')
				return
			}

			// main. Add wrapper page node and restore class
			// Replace the "Starting…" placeholder with the fully-rendered shell.
			// Manually drain firstChild instead of innerHTML = '' to avoid triggering
			// resize observers on partially-removed subtrees in older browsers.
			while (main.firstChild) {
				main.removeChild(main.firstChild);
			}
			main.appendChild(wrapper_page)
			main.classList.remove('hide')

		// error-report launcher. On pages WITHOUT the menu bar (e.g. a thesaurus
		// term in a ?menu=false window) the menu button is absent; this injects a
		// floating admin-only fallback so a problem can be reported from any page.
		// Lazy + best-effort: never blocks or breaks the boot.
			import('../../common/js/error_report_launcher.js')
				.then(m => m.install_error_report_launcher())
				.catch(err => console.error('error_report_launcher load failed', err))

		// debug
			if (window.SHOW_DEBUG === true) {
				console.log("%c + Page instantiated, built and rendered total (ms): ", 'background: #000000; color: violet', performance.now()-t0 )
			}

	} catch (err) {
		// Bootstrap failure handler.
		// Shows a plain error message in #main rather than leaving a blank screen.
		// The full error is always forwarded to the console for diagnostics.
		// (!) `error_ode` below is a typo for `error_node`; do not rename here —
		// it is a variable-only identifier with no external contract, but flagged
		// so it can be corrected in a dedicated code-change commit.
		sync_main_css(null) // no-op when a sheet is already present
		const main = document.getElementById('main')
		if (main) {
			while (main.firstChild) main.removeChild(main.firstChild)
			const error_ode = document.createElement('div')
			error_ode.className = 'starting error'
			error_ode.textContent = 'Error starting page. See console.'
			main.appendChild(error_ode)
			main.classList.remove('hide')
		}
		console.error('Error bootstrapping page:', err)
	}

})()


// @license-end
