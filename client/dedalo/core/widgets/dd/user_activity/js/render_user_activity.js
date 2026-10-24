// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_ROOT_WEB*/
/*eslint no-undef: "error"*/



/**
* RENDER_USER_ACTIVITY
* Client-side renderer for the `user_activity` widget hosted inside
* component_info (dd/user_activity).
*
* Responsibilities:
*  - Fetches aggregated user-activity statistics asynchronously via the
*    `dd_component_info` API action (`get_widget_data`) when the PHP side
*    skips synchronous computation (is_async() === true).
*  - Normalises the multi-shape server payload into a canonical
*    `{who, what, where, when, publish}` object via `normalize_totals`.
*  - Renders a two-part panel: a KPI summary strip (pure DOM, always
*    visible) and a D3-backed chart grid (lazy-loaded, deferred until
*    `wrapper.offsetWidth > 0` to cope with tab/panel insertion timing).
*
* Data flow:
*  1. PHP class `user_activity` sets `is_async()` → true, so no server-side
*     `self.value` is populated on initial page render.
*  2. `get_content_data_edit` fires `get_widget_data` and writes the result
*     back into `self.value`.
*  3. Server response: array of items `{ widget, key, widget_id:'totals',
*     value: <canonical|flat-raw|null> }`.
*  4. `build_totals_charts` renders the item whose `widget_id === 'totals'`.
*
* D3 is loaded lazily from `/lib/d3/dist/d3.min.js` and cached on
* `window.__dedalo_d3` so the bundle is not fetched more than once per page
* session (shared with the area-dashboard chart).
*
* Exports: {render_user_activity}
*/

// imports
import {ui} from '../../../../common/js/ui.js'
import {event_manager} from '../../../../common/js/event_manager.js'
import {data_manager} from '../../../../common/js/data_manager.js'
import {response_data} from '../../../../common/js/api_error.js'



// Color palette (CSS variables resolved at runtime by the chart code).
const PALETTE = [
	'#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
	'#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
	'#14b8a6', '#a855f7', '#f43f5e', '#22c55e', '#eab308'
]

const SHOW_DEBUG_GLOBAL = (typeof SHOW_DEBUG !== 'undefined' && SHOW_DEBUG === true)



/**
* LOAD_D3
* Lazily imports the bundled D3 build from the configured web root, caching
* the resolved module on `window.__dedalo_d3` so subsequent calls in the same
* page session pay no network cost. The shared key also means the area-dashboard
* and this widget reuse the same singleton if both are active.
*
* Falls back to `window.d3` when the dynamic import succeeds but the module's
* default export does not expose `d3.select` (e.g. UMD script-tag load).
* Returns null on network failure so callers can degrade gracefully.
*
* @returns {Promise<Object|null>} The D3 namespace, or null if loading fails.
*/
const load_d3 = async function() {

	if (typeof window !== 'undefined' && window.__dedalo_d3) {
		return window.__dedalo_d3
	}

	const base = (typeof DEDALO_ROOT_WEB !== 'undefined' && DEDALO_ROOT_WEB)
		? DEDALO_ROOT_WEB
		: ''
	const url = base + '/lib/d3/dist/d3.min.js'

	try {
		const mod = await import(url)
		const d3 = mod && (mod.default || mod)
		const resolved = (d3 && d3.select) ? d3 : (typeof window!=='undefined' ? window.d3 : null)
		if (typeof window !== 'undefined') {
			window.__dedalo_d3 = resolved
		}
		return resolved
	} catch (e) {
		if (typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) {
			console.warn('user_activity: failed to load D3 from', url, e)
		}
		return null
	}
}//end load_d3



/**
* FORMAT_NUMBER
* Locale-aware integer formatting with thousand separators, used in KPI tiles
* and SVG data labels. Guards against non-finite values (Infinity, NaN) that
* arrive when a dimension aggregation finds no rows. Falls back to `String(n)`
* when `toLocaleString` throws (e.g. some older runtime environments).
*
* @param {number} n - The number to format.
* @returns {string} Locale-formatted string, or the coerced string for
*   non-finite / non-number inputs.
*/
const format_number = function(n) {

	if (typeof n !== 'number' || !isFinite(n)) return String(n ?? '')
	try {
		return n.toLocaleString()
	} catch (_e) {
		return String(n)
	}
}//end format_number



/**
* TRUNCATE
* Cuts a string to at most `max` characters, replacing the last character
* with a Unicode ellipsis (…) when truncation occurs. Used to fit section
* labels inside the fixed-width SVG label column and the KPI "Top section"
* tile without causing text overflow.
*
* Returns an empty string for non-string inputs (guards against null/undefined
* values from the server payload's `label` field).
*
* @param {string} str - The string to truncate.
* @param {number} max - Maximum character count (inclusive).
* @returns {string} The possibly-truncated string.
*/
const truncate = function(str, max) {

	if (typeof str !== 'string') return ''
	return str.length > max ? str.slice(0, max - 1) + '…' : str
}//end truncate



/**
* RENDER_USER_ACTIVITY
* ES6 class that provides the client-side rendering contract expected by
* component_info's widget dispatch layer. An instance is created by the
* component_info renderer and its `edit()` method is called to produce the
* DOM subtree inserted into the component's wrapper.
*
* The class is stateless: all contextual data (tipo, section_id, value, ipo,
* caller, mode) is accessed through the `self` (component_info instance)
* received by the rendering helpers.
*
* Exported as the default symbol so component_info can dynamically import:
*   const { render_user_activity } = await import('.../render_user_activity.js')
*/
export class render_user_activity {

	constructor() {
		return true
	}

	/**
	* EDIT
	* Entry point for the `edit` and `edit_in_list` render modes. Triggers an
	* asynchronous data fetch when `self.value` is absent (the normal case,
	* because `user_activity::is_async()` is true), then builds the widget DOM.
	*
	* When `render_level === 'content'` the method returns only the inner
	* content node, omitting the outer wrapper. This matches the pattern used
	* by component_info when re-rendering after a data refresh.
	*
	* @param {Object} options
	* @param {string} options.render_level - `'content'` to return the inner
	*   node only; any other value returns the full widget wrapper.
	* @returns {Promise<HTMLElement>} The DOM node to insert.
	*/
	async edit(options) {

		const self = this

		const render_level = options.render_level

		// content_data
			const content_data = await get_content_data_edit(self)
			if (render_level==='content') {
				return content_data
			}

		// wrapper. ui build_edit returns widget wrapper
			const wrapper = ui.widget.build_wrapper_edit(self, {
				content_data : content_data
			})


		return wrapper
	}//end edit
}



/**
* GET_CONTENT_DATA_EDIT
* Builds the inner content node for the widget in edit mode. When `self.value`
* is empty (normal for async widgets), sends a `get_widget_data` request to the
* `dd_component_info` API action. The API calls `user_activity::get_data()` on
* the PHP side and returns an array of activity items which is written back to
* `self.value` so subsequent renders can skip the fetch.
*
* The IPO (input-process-output) array from the ontology descriptor drives the
* outer loop: one `<li>` is rendered per IPO entry, each containing the totals
* chart panel produced by `build_totals_charts`.
*
* RQO shape sent to the API:
* ```json
* {
*   "action"      : "get_widget_data",
*   "dd_api"      : "dd_component_info",
*   "source"      : { "tipo", "section_tipo", "section_id", "mode" },
*   "options"     : { "widget_name": "user_activity" }
* }
* ```
*
* @param {Object} self - The component_info instance that hosts this widget.
*   Expected properties: value, caller, mode, ipo, name.
* @returns {Promise<HTMLElement>} A `<div>` containing a `<ul>` of activity items.
*/
const get_content_data_edit = async function(self) {

	// Async data fetch: triggered when PHP skipped synchronous computation because
	// user_activity::is_async() returns true. The caller context supplies the
	// section owner's tipo/section_tipo/section_id (the user whose stats to show).
	if ((!self.value || self.value.length < 1) && self.caller) {
		try {
			const rqo = {
				action	: 'get_widget_data',
				dd_api	: 'dd_component_info',
				source	: {
					tipo		: self.caller.tipo,
					section_tipo: self.caller.section_tipo,
					section_id	: self.caller.section_id,
					mode		: self.mode
				},
				options	: {
					widget_name: self.name
				}
			}
			const api_response = await data_manager.request({ body: rqo })
			const value = response_data(api_response)
			if (value) {
				self.value = value
			}
		} catch (e) {
			if (SHOW_DEBUG_GLOBAL) {
				console.warn('[user_activity] async data fetch failed:', e)
			}
		}
	}

	if (!self.value || self.value.length<1) {
		if (SHOW_DEBUG_GLOBAL) {
			console.warn("user_activity get_content_data_edit. Value is empty!", self);
		}
	}

	const fragment = new DocumentFragment()

	// values container
		const values_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'values_container',
			parent			: fragment
		})

	// values
		const ipo			= self.ipo
		const ipo_length	= ipo.length

		for (let i = 0; i < ipo_length; i++) {
			const data = self.value.filter(item => item.key === i)
			get_value_element(i, data , values_container, self)
		}

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div'
		})
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* GET_VALUE_ELEMENT
* Creates a single `<li>` entry for one IPO slot and attaches its chart panel.
* The `data` array is the subset of `self.value` whose `key` matches the current
* IPO index `i`. Within that subset this function looks for the item whose
* `widget_id` is `'totals'` — the only widget_id the PHP class currently
* produces — and hands its `value` payload to `build_totals_charts`.
*
* If no `totals` item is present (e.g. data fetch failed), `build_totals_charts`
* still renders an empty-state placeholder via the null-safe code path.
*
* @param {number}      i                - IPO slot index (0-based).
* @param {Array}       data             - Activity items filtered for key === i.
* @param {HTMLElement} values_container - The `<ul>` element to append to.
* @param {Object}      self             - The component_info instance (unused
*   directly here but available for future extension).
* @returns {HTMLElement} The appended `<li>` element.
*/
const get_value_element = (i, data, values_container, self) => {

	// One <li> per IPO entry; the CSS class `user_activity` scopes widget styles.
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item user_activity',
			parent			: values_container
		})

	// totals — visual chart panel
		const totals_item = data.find(item => item.widget_id === 'totals')
		const totals = totals_item ? totals_item.value : null
		const charts_panel = build_totals_charts(totals)
		li.appendChild(charts_panel)


	return li
}//end get_value_element



/**
* NORMALIZE_TOTALS
* Accepts any of the historical user-activity payload shapes produced by the
* PHP server and returns the canonical `{who, what, where, when, publish}`
* object used by all rendering helpers in this module.
*
* The PHP-side payload has evolved through multiple backend iterations; this
* function acts as the single adaptation point so callers never need to branch
* on payload shape.
*
* Supported input forms:
*
*  1. null / undefined / empty string / false
*       → returns null (no activity data to display).
*
*  2. Already-canonical object `{ who:Array, what:Array, where:Array,
*       when:Array, publish:Array }`
*       → passed through unchanged. Detected by presence of at least one
*         dimension key whose value is an Array.
*
*  3. Flat raw array from `diffusion_section_stats::get_interval_raw_activity_data`:
*       `[{type:'what', tipo, value, label}, {type:'when', hour, value}, …]`
*       → grouped by `type` into the canonical object. The `when` dimension
*         is pre-seeded with 24 zero-valued slots (hours 0–23) for visual
*         continuity in the bar chart; slots with no activity remain at 0 and
*         the whole `when` array is dropped if no hour has a non-zero value.
*
*  4. component_json wrapper (legacy cache format):
*       `[{value:[…], lang:'ca'}]`
*       → unwraps `[0].value` and re-enters the normalisation logic.
*
* @param {*} input - Raw server payload in any supported shape.
* @returns {Object|null} Canonical activity object, or null if there is
*   no data to display.
*/
const normalize_totals = function(input) {

	if (!input) return null

	// component_json wrapper: [{value:[...], lang}]
	if (Array.isArray(input) && input.length > 0 && input[0] && Array.isArray(input[0].value)) {
		input = input[0].value
	}

	// Already-canonical object?
	if (!Array.isArray(input) && typeof input === 'object') {
		const has_dim = ['who','what','where','when','publish'].some(k => Array.isArray(input[k]))
		if (has_dim) {
			return input
		}
	}

	// Flat raw array → group by `type`
	if (Array.isArray(input)) {

		const out = { who: [], what: [], where: [], when: [], publish: [] }
		const when_index = {}
		for (let h = 0; h < 24; h++) {
			when_index[h] = { key: h, label: String(h).padStart(2, '0'), value: 0 }
			out.when.push(when_index[h])
		}
		const indexes = { what: {}, where: {}, publish: {}, who: {} }

		for (const it of input) {
			if (!it || typeof it.value !== 'number') continue
			const type = it.type
			if (type === 'when') {
				const h = Number(it.hour ?? it.key)
				if (Number.isInteger(h) && h >= 0 && h < 24) {
					when_index[h].value += it.value
				}
				continue
			}
			if (type === 'what' || type === 'where' || type === 'publish' || type === 'who') {
				const k = it.tipo ?? it.key
				if (!k) continue
				const bucket = indexes[type]
				if (bucket[k]) {
					bucket[k].value += it.value
				} else {
					bucket[k] = { key: k, label: it.label || k, value: it.value }
					out[type].push(bucket[k])
				}
			}
		}

		// Drop the empty `when` array if nothing was registered.
		if (!out.when.some(d => d.value > 0)) out.when = []

		return out
	}


	return null
}//end normalize_totals



/**
* BUILD_TOTALS_CHARTS
* Builds the full visual panel for the `totals` widget output. The panel
* has two layers:
*
*  1. Summary KPI strip — rendered synchronously via `build_summary_strip`;
*     no D3 required. Displays total actions, sections touched, peak hour,
*     top section, and publications count.
*
*  2. Chart grid — one card per active dimension (what / where / when / publish).
*     Cards are built immediately with a `Loading…` placeholder, then upgraded
*     asynchronously once `load_d3()` resolves. Upgrade is further delayed until
*     the wrapper is laid out in the DOM (`wrapper.offsetWidth > 0`), polling
*     every 33 ms for up to ~1 s. This avoids zero-width SVG when the widget
*     is inside a hidden tab or panel.
*
* When raw_totals normalises to null (no data) an empty-state element is
* returned immediately without building the chart grid.
*
* When D3 fails to load, each chart slot falls back to a `<pre>` with the
* raw JSON for that dimension — enough to debug without crashing.
*
* @param {Object|Array|null} raw_totals - Server payload in any shape
*   accepted by `normalize_totals`.
* @returns {HTMLElement} Wrapper `<div class="user_activity_charts">` with
*   the KPI strip and chart grid inside.
*/
const build_totals_charts = function(raw_totals) {

	const wrapper = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'user_activity_charts'
	})

	const totals = normalize_totals(raw_totals)

	if (SHOW_DEBUG_GLOBAL) {
		// eslint-disable-next-line no-console
		console.log('[user_activity] raw payload:', raw_totals, '| normalized:', totals)
	}

	if (!totals) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_charts_empty',
			inner_html		: (typeof get_label!=='undefined' && get_label.no_data) || 'No activity data',
			parent			: wrapper
		})
		return wrapper
	}

	// ---- Summary KPI strip (works without D3) ----
	wrapper.appendChild(build_summary_strip(totals))

	// ---- Charts grid (placeholder; upgraded once D3 is ready) ----
	const grid = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'user_activity_charts_grid',
		parent			: wrapper
	})

	// Decide which sections to render based on data presence.
	const sections = []
	if (Array.isArray(totals.what)    && totals.what.length    > 0) sections.push({ key: 'what',    label: 'Activity by type'   })
	if (Array.isArray(totals.where)   && totals.where.length   > 0) sections.push({ key: 'where',   label: 'Activity by section' })
	if (Array.isArray(totals.when)    && totals.when.some(d => d && d.value > 0)) sections.push({ key: 'when',    label: 'Activity by hour'    })
	if (Array.isArray(totals.publish) && totals.publish.length > 0) sections.push({ key: 'publish', label: 'Publications'        })

	if (sections.length === 0) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_charts_empty',
			inner_html		: (typeof get_label!=='undefined' && get_label.no_data) || 'No activity data',
			parent			: grid
		})
		return wrapper
	}

	const hosts = {}
	for (const s of sections) {
		const card = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_chart user_activity_chart_' + s.key,
			parent			: grid
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_chart_title',
			inner_html		: s.label,
			parent			: card
		})
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_chart_body',
			parent			: card
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_chart_loading',
			inner_html		: 'Loading…',
			parent			: body
		})
		hosts[s.key] = body
	}

	// Async D3 upgrade: load_d3 is non-blocking; the placeholder "Loading…"
	// elements inside each card body are replaced once D3 resolves.
	load_d3().then(d3 => {

		if (!d3) {
			// eslint-disable-next-line no-console
			console.warn('[user_activity] D3 not available, rendering JSON fallback.')
			// Degrade gracefully: replace "Loading…" with indented raw JSON so a
			// developer can at least inspect the data without opening DevTools.
			for (const key of Object.keys(hosts)) {
				hosts[key].innerHTML = ''
				const fb = ui.create_dom_element({
					element_type : 'pre',
					class_name   : 'user_activity_chart_fallback',
					inner_html   : JSON.stringify(totals[key], null, 2),
					parent       : hosts[key]
				})
				fb.title = 'D3 unavailable — raw data shown.'
			}
			return
		}

		// Wait until the panel is laid out (offsetWidth > 0). The widget may
		// be inserted asynchronously into a tab/panel, so we poll for up to
		// ~1s before falling back to a hard-coded width.
		// (!) After 30 attempts the chart is rendered regardless; wrapper.offsetWidth
		// may then be 0, causing the SVG to render at the hard-coded fallback width
		// inside render_horizontal_bars / render_when_chart (clientWidth || 380).
		const try_render = function(attempt) {
			const ready = wrapper.isConnected && wrapper.offsetWidth > 0
			if (!ready && attempt < 30) {
				return setTimeout(() => try_render(attempt + 1), 33)
			}
			if (SHOW_DEBUG_GLOBAL) {
				// eslint-disable-next-line no-console
				console.log('[user_activity] rendering charts. wrapper width:', wrapper.offsetWidth, 'attempt:', attempt)
			}
			// Clear the "Loading…" placeholder before injecting the SVG.
			if (hosts.what)    { hosts.what.innerHTML    = ''; render_what_chart(d3, hosts.what, totals.what || []) }
			if (hosts.where)   { hosts.where.innerHTML   = ''; render_where_chart(d3, hosts.where, totals.where || []) }
			if (hosts.when)    { hosts.when.innerHTML    = ''; render_when_chart(d3, hosts.when, totals.when || []) }
			if (hosts.publish) { hosts.publish.innerHTML = ''; render_publish_chart(d3, hosts.publish, totals.publish || []) }
		}
		try_render(0)
	})


	return wrapper
}//end build_totals_charts



/**
* BUILD_SUMMARY_STRIP
* Renders the five KPI tiles displayed above the D3 chart grid. Pure DOM,
* no D3 dependency — always visible even if the D3 bundle fails to load.
*
* Tiles produced (in order):
*  - Total actions : sum of `where` values (preferred) or `what` values.
*  - Sections touched : count of distinct `where` entries.
*  - Peak hour : the `when` slot with the highest `value`, formatted as HH:00.
*  - Top section : the `where` entry with the highest `value` (label truncated
*    to 22 chars); hover hint shows the action count.
*  - Publications : sum of `publish` values.
*
* An optional `hint` string is added as a smaller subdued element beneath the
* value, giving context for the Peak hour and Top section tiles.
*
* @param {Object} totals - Canonical activity object with dimension arrays
*   `{who, what, where, when, publish}`.
* @returns {HTMLElement} A `<div class="user_activity_summary">` containing
*   one `<div class="user_activity_summary_tile">` per KPI.
*/
const build_summary_strip = function(totals) {

	const sum_values = arr => Array.isArray(arr)
		? arr.reduce((acc, x) => acc + (Number(x && x.value) || 0), 0)
		: 0

	const total_actions = sum_values(totals.where) || sum_values(totals.what)

	const sections_touched = Array.isArray(totals.where) ? totals.where.length : 0

	let peak_hour = null
	let peak_hour_value = -1
	if (Array.isArray(totals.when)) {
		for (const h of totals.when) {
			if (!h || typeof h.value !== 'number') continue
			if (h.value > peak_hour_value) {
				peak_hour_value = h.value
				peak_hour = h
			}
		}
	}

	let top_section = null
	if (Array.isArray(totals.where) && totals.where.length > 0) {
		top_section = totals.where.slice().sort((a, b) => (b.value || 0) - (a.value || 0))[0]
	}

	const total_publications = sum_values(totals.publish)

	const tiles = [
		{ label: 'Total actions',		value: format_number(total_actions) },
		{ label: 'Sections touched',	value: format_number(sections_touched) },
		{ label: 'Peak hour',			value: peak_hour && peak_hour_value > 0
			? `${String(peak_hour.label || peak_hour.key).padStart(2,'0')}:00`
			: '—',
			hint: peak_hour && peak_hour_value > 0 ? `${format_number(peak_hour_value)} actions` : '' },
		{ label: 'Top section',			value: top_section ? truncate(top_section.label || top_section.key, 22) : '—',
			hint: top_section ? format_number(top_section.value) + ' actions' : '' },
		{ label: 'Publications',		value: format_number(total_publications) }
	]

	const strip = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'user_activity_summary'
	})

	for (const tile of tiles) {
		const t = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_summary_tile',
			parent			: strip
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_summary_label',
			inner_html		: tile.label,
			parent			: t
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_summary_value',
			inner_html		: tile.value,
			parent			: t
		})
		if (tile.hint) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'user_activity_summary_hint',
				inner_html		: tile.hint,
				parent			: t
			})
		}
	}


	return strip
}//end build_summary_strip



/**
* RENDER_HORIZONTAL_BARS
* Generic D3 horizontal-bar renderer shared by the `what`, `where`, and
* `publish` chart slots. Produces an SVG with left-aligned text labels,
* colour-coded bars from the shared PALETTE, and trailing count labels.
*
* Layout constants:
*  - `label_width` pixels reserved on the left for truncated text labels.
*  - `padding_right` = 56px to accommodate trailing count labels.
*  - Row height fixed at 24 px; top/bottom padding at 4 px each.
*  - SVG `viewBox` is set to the host's `offsetWidth` so the chart fills the
*    card width responsively via `width:100%`.
*
* When `clickable` is true each row:
*  - Gets `tabindex="0"` and `role="link"` for keyboard accessibility.
*  - Fires `navigate_to_section` on click / Enter / Space.
*  - A transparent full-row `<rect>` enlarges the click target to the full
*    row height, not just the bar.
*  - Alt+click opens the section in a new browser tab.
*
* Rows are sorted descending by value; only the top `max_rows` are rendered.
* A "+N more" footer appears when rows are truncated. Values are coerced to
* numbers so that PHP/JSON strings like `"12"` do not break the scale domain.
*
* @param {Object}      d3        - D3 namespace (loaded via `load_d3`).
* @param {HTMLElement} host      - DOM node that receives the SVG.
* @param {Array}       rows      - Data rows `[{key, label, value}, …]`.
* @param {Object}      opts      - Configuration overrides.
* @param {number}      [opts.max_rows=12]    - Maximum bars to render.
* @param {boolean}     [opts.clickable=false] - Enable row navigation.
* @param {number}      [opts.label_width=160] - Left label column width (px).
* @returns {void}
*/
const render_horizontal_bars = function(d3, host, rows, opts) {

	const cfg = Object.assign({
		max_rows	: 12,
		clickable	: false,
		label_width	: 160
	}, opts || {})

	// Coerce values to numbers (PHP/JSON sometimes serializes counts as strings).
	const all = (rows || [])
		.map(r => r && Object.assign({}, r, { value: Number(r.value) || 0 }))
		.filter(r => r && r.value > 0)
		.sort((a, b) => b.value - a.value)
	if (all.length === 0) {
		ui.create_dom_element({
			element_type : 'div',
			class_name   : 'user_activity_chart_empty',
			inner_html   : 'No data',
			parent       : host
		})
		return
	}

	const data		= all.slice(0, cfg.max_rows)
	const hidden	= all.length - data.length

	const row_h			= 24
	const padding_top	= 4
	const padding_bot	= 4
	const padding_left	= cfg.label_width
	const padding_right	= 56
	const width			= host.offsetWidth > 0 ? host.offsetWidth : (host.clientWidth || 380)
	const height		= padding_top + padding_bot + data.length * row_h

	const svg = d3.select(host)
		.append('svg')
		.attr('viewBox', `0 0 ${width} ${height}`)
		.attr('preserveAspectRatio', 'xMinYMin meet')
		.style('width', '100%')
		.style('height', height + 'px')
		.style('display', 'block')

	const max_v	= d3.max(data, d => d.value) || 1
	const x		= d3.scaleLinear().domain([0, max_v]).range([padding_left, width - padding_right])
	const y		= d3.scaleBand()
		.domain(data.map((_, i) => i))
		.range([padding_top, height - padding_bot])
		.padding(0.18)

	const rows_g = svg.append('g')
		.selectAll('g')
		.data(data)
		.join('g')
		.attr('class', 'user_activity_where_row')
		.attr('transform', (_, i) => `translate(0, ${y(i)})`)

	if (cfg.clickable) {
		rows_g
			.attr('tabindex', 0)
			.attr('role', 'link')
			.style('cursor', 'pointer')
			.on('click', function(event, d) { navigate_to_section(d, event) })
			.on('keydown', function(event, d) {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					navigate_to_section(d, event)
				}
			})
		// Full-row hit area
		rows_g.append('rect')
			.attr('x', 0).attr('y', 0)
			.attr('width', width).attr('height', y.bandwidth())
			.attr('fill', 'transparent')
	}

	rows_g.append('text')
		.attr('class', 'user_activity_where_label')
		.attr('x', padding_left - 8)
		.attr('y', y.bandwidth() / 2)
		.attr('dy', '0.35em')
		.attr('text-anchor', 'end')
		.text(d => truncate(String(d.label || d.key || ''), Math.max(8, Math.floor((padding_left - 16) / 6))))
		.append('title')
		.text(d => (d.label || d.key) + (cfg.clickable ? ' — click to open' : ''))

	rows_g.append('rect')
		.attr('class', 'user_activity_where_bar')
		.attr('x', padding_left)
		.attr('y', 0)
		.attr('width', d => Math.max(1, x(d.value) - padding_left))
		.attr('height', y.bandwidth())
		.attr('fill', (_, i) => PALETTE[i % PALETTE.length])
		.append('title')
		.text(d => `${d.label || d.key}: ${format_number(d.value)}` + (cfg.clickable ? ' — click to open' : ''))

	rows_g.append('text')
		.attr('class', 'user_activity_where_value')
		.attr('x', d => x(d.value) + 6)
		.attr('y', y.bandwidth() / 2)
		.attr('dy', '0.35em')
		.text(d => format_number(d.value))

	if (hidden > 0) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_activity_where_more',
			text_content	: `+${hidden} more`,
			parent			: host
		})
	}
}//end render_horizontal_bars



/**
* RENDER_WHAT_CHART
* Renders horizontal bars for the `what` dimension — breakdown of activity by
* action type (modification, indexation, deletion, publication, …). Non-clickable
* because action types are not navigable entities in the application.
*
* @param {Object}      d3   - D3 namespace.
* @param {HTMLElement} host - Chart body element.
* @param {Array}       rows - `what` dimension rows `[{key, label, value}]`.
* @returns {void}
*/
const render_what_chart = function(d3, host, rows) {
	render_horizontal_bars(d3, host, rows, { max_rows: 12, clickable: false, label_width: 160 })
}//end render_what_chart



/**
* RENDER_WHERE_CHART
* Renders horizontal bars for the `where` dimension — breakdown of activity by
* section tipo. Each bar is clickable: left-click publishes a `user_navigation`
* event that the page's SPA router handles to open the section's list view;
* Alt+click opens the section in a new browser tab. Keyboard: Enter/Space.
*
* A slightly wider label column (180 px) is used compared to `what` because
* section labels tend to be longer.
*
* @param {Object}      d3   - D3 namespace.
* @param {HTMLElement} host - Chart body element.
* @param {Array}       rows - `where` dimension rows `[{key, label, value}]`
*   where `key` is the section tipo string.
* @returns {void}
*/
const render_where_chart = function(d3, host, rows) {
	render_horizontal_bars(d3, host, rows, { max_rows: 12, clickable: true, label_width: 180 })
}//end render_where_chart



/**
* NAVIGATE_TO_SECTION
* Handles user interaction on a clickable `where` chart row. Performs SPA
* navigation to the target section's list view using one of two strategies:
*
*  - Alt+click: opens `?tipo=<tipo>&mode=list` as a new browser tab. Uses
*    `window.location.pathname` to keep the base URL correct on multi-path
*    deployments. Falls back to empty string in non-browser environments.
*  - Normal click / keyboard: publishes a `user_navigation` event to the
*    application event bus (`event_manager`). The `page.js` subscriber picks
*    this up and drives the SPA router to load the section in list mode.
*
* Returns early (no-op) when `row` is falsy or `row.key` is empty — safe to
* call on D3 click events even when the datum is malformed.
*
* @param {Object}          row    - The clicked data row from the `where` array.
* @param {string}          row.key - Section tipo used as the navigation target.
* @param {string}          [row.label] - Human-readable label (unused here).
* @param {MouseEvent|KeyboardEvent|undefined} ev - DOM event; inspected for
*   `altKey` to decide new-tab vs SPA navigation.
* @returns {void}
*/
const navigate_to_section = function(row, ev) {

	if (!row || !row.key) return

	if (ev && ev.altKey === true) {
		const base = (typeof window !== 'undefined' && window.location.pathname) ? window.location.pathname : ''
		const url = `${base}?tipo=${encodeURIComponent(row.key)}&mode=list`
		const win = window.open(url, '_blank')
		if (win) win.focus()
		return
	}
	event_manager.publish('user_navigation', {
		source : {
			tipo : row.key,
			model: 'section',
			mode : 'list'
		}
	})
}//end navigate_to_section



/**
* RENDER_WHEN_CHART
* Renders a vertical 24-column bar chart of activity by hour-of-day. Bars are
* colour-coded by daypart for at-a-glance scanning:
*   - 06:00–11:59 (morning)   → green  (#10b981)
*   - 12:00–17:59 (afternoon) → amber  (#f59e0b)
*   - 18:00–21:59 (evening)   → purple (#8b5cf6)
*   - 22:00–05:59 (night)     → slate  (#475569)
*
* The 24-slot array is always populated (zero-value hours stay at 0), giving
* a complete hour axis even when activity is sparse. Bars for zero-value hours
* are rendered at 18% opacity as a visual guide.
*
* X-axis labels are shown every 2 hours (00, 02, 04 … 22) to avoid overcrowding
* at narrow widths. Y-axis gridlines and labels are generated from `y.ticks(4)`.
*
* SVG height is fixed at 200 px; width follows `host.offsetWidth` (with
* `clientWidth || 380` fallback).
*
* @param {Object}      d3   - D3 namespace.
* @param {HTMLElement} host - Chart body element.
* @param {Array}       rows - `when` dimension rows `[{key:0..23, label:'HH',
*   value:number}]`. Missing hours are filled with 0.
* @returns {void}
*/
const render_when_chart = function(d3, host, rows) {

	// Normalize into a 24-slot dataset (preserving zeros for visual continuity).
	const hours = []
	for (let h = 0; h < 24; h++) hours.push({ hour: h, value: 0 })
	for (const r of (rows || [])) {
		if (!r) continue
		const h = Number(r.key ?? r.hour)
		if (!Number.isInteger(h) || h < 0 || h > 23) continue
		hours[h].value = Number(r.value) || 0
	}

	const max_v = Math.max(...hours.map(h => h.value))
	if (max_v <= 0) {
		ui.create_dom_element({
			element_type : 'div',
			class_name   : 'user_activity_chart_empty',
			inner_html   : 'No data',
			parent       : host
		})
		return
	}

	const width			= host.offsetWidth > 0 ? host.offsetWidth : (host.clientWidth || 380)
	const height		= 200
	const padding_top	= 12
	const padding_bot	= 22
	const padding_left	= 28
	const padding_right	= 8
	const inner_w		= width - padding_left - padding_right
	const inner_h		= height - padding_top - padding_bot

	const svg = d3.select(host)
		.append('svg')
		.attr('viewBox', `0 0 ${width} ${height}`)
		.attr('preserveAspectRatio', 'xMinYMin meet')
		.style('width', '100%')
		.style('height', height + 'px')
		.style('display', 'block')

	const x = d3.scaleBand()
		.domain(hours.map(h => h.hour))
		.range([padding_left, padding_left + inner_w])
		.padding(0.15)

	const y = d3.scaleLinear()
		.domain([0, max_v])
		.nice()
		.range([padding_top + inner_h, padding_top])

	// Y-axis gridlines + labels
	const y_ticks = y.ticks(4)
	svg.append('g')
		.selectAll('line')
		.data(y_ticks)
		.join('line')
		.attr('x1', padding_left).attr('x2', width - padding_right)
		.attr('y1', d => y(d)).attr('y2', d => y(d))
		.attr('stroke', 'var(--border_default, #cbd5e1)')
		.attr('stroke-dasharray', '2 3')
		.attr('opacity', 0.5)

	svg.append('g')
		.selectAll('text')
		.data(y_ticks)
		.join('text')
		.attr('class', 'user_activity_axis_label')
		.attr('x', padding_left - 4)
		.attr('y', d => y(d))
		.attr('dy', '0.32em')
		.attr('text-anchor', 'end')
		.text(d => format_number(d))

	// Daypart color mapping
	const color_for = h => {
		if (h >= 6  && h < 12) return '#10b981' // morning
		if (h >= 12 && h < 18) return '#f59e0b' // afternoon
		if (h >= 18 && h < 22) return '#8b5cf6' // evening
		return '#475569' // night
	}

	// Bars
	svg.append('g')
		.selectAll('rect')
		.data(hours)
		.join('rect')
		.attr('class', 'user_activity_when_bar')
		.attr('x', d => x(d.hour))
		.attr('y', d => y(d.value))
		.attr('width', x.bandwidth())
		.attr('height', d => Math.max(0, (padding_top + inner_h) - y(d.value)))
		.attr('fill', d => color_for(d.hour))
		.attr('opacity', d => d.value > 0 ? 0.92 : 0.18)
		.append('title')
		.text(d => `${String(d.hour).padStart(2,'0')}:00 — ${format_number(d.value)} action${d.value===1?'':'s'}`)

	// X-axis labels (every 2 hours to avoid clutter)
	svg.append('g')
		.selectAll('text')
		.data(hours.filter(h => h.hour % 2 === 0))
		.join('text')
		.attr('class', 'user_activity_axis_label')
		.attr('x', d => x(d.hour) + x.bandwidth() / 2)
		.attr('y', height - 6)
		.attr('text-anchor', 'middle')
		.text(d => String(d.hour).padStart(2, '0'))
}//end render_when_chart



/**
* RENDER_PUBLISH_CHART
* Renders horizontal bars for the `publish` dimension — breakdown of publication
* actions by target (diffusion channel, SQL target, etc.). Non-clickable because
* publication targets are not navigable section entities.
*
* Uses a narrower label column (140 px) than `where` since publication target
* labels are typically shorter strings.
*
* @param {Object}      d3   - D3 namespace.
* @param {HTMLElement} host - Chart body element.
* @param {Array}       rows - `publish` dimension rows `[{key, label, value}]`.
* @returns {void}
*/
const render_publish_chart = function(d3, host, rows) {
	render_horizontal_bars(d3, host, rows, { max_rows: 10, clickable: false, label_width: 140 })
}//end render_publish_chart



// @license-end
