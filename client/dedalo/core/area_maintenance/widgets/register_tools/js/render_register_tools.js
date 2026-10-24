// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_REGISTER_TOOLS
* Client-side rendering layer for the `register_tools` maintenance widget.
*
* This widget displays all discovered Dédalo tool directories in a tabular view
* and lets an administrator trigger the `register_tools` API action, which calls
* `tools_register::import_tools()` on the server to synchronise the tool registry
* with the current on-disk state.
*
* Data source
* -----------
* `self.value` is populated by the server via `register_tools::get_value()`:
*   {
*     datalist : Array<{
*       name              : {string}        — directory name of the tool
*       version           : {string|null}   — version declared in register.json
*       developer         : {string|null}   — developer name from register.json
*       installed_version : {string|null}   — version stored in the ontology DB (null = not yet registered)
*       warning           : {string|null}   — pre-composed server-side warning (e.g. missing register.json)
*       active            : {boolean}       — dd1354 registry state; seeds the Active checkbox
*       on_disk           : {boolean}       — false = registered but its directory is gone
*       state             : {string}        — 'ok' | 'outdated' | 'unregistered' | 'missing'
*     }>,
*     registry_state : {                    — the same verdict, summarised
*       total        : {number},
*       outdated     : {Array<string>},     — names shipping a version the registry lacks
*       unregistered : {Array<string>},     — names on disk with no registry row
*       missing      : {Array<string>}      — names registered with no directory
*     },
*     errors : {Array<string>|null}         — fatal errors (e.g. outdated ontology)
*   }
*
* `state` / `registry_state` are the SERVER's classification and the only source
* this file (and the maintenance map's Tools node) reads for drift — see the
* Version columns note below.
*
* Active checkboxes (WC-057)
* --------------------------
* The leading Active column is not a row selector — it IS the tool's dd1354
* state. The boxes are seeded from the registry, collected into the live
* `tools_active` map (name → boolean) that is handed to the submit form as
* `options.tools_active`, and the server writes exactly what is on screen:
* unchecked ⇒ the tool is still registered (version/label synced) but written
* inactive, so it disappears from every user's tool menu. Doing nothing
* registers everything active, as before.
*
* A row with `on_disk === false` has no directory for the importer to read, so
* its checkbox is disabled and it is left out of `tools_active` entirely —
* the panel never offers a control the action cannot honour.
*
* Widget render flow (prototype chain)
* -------------------------------------
* 1. `register_tools.prototype.list` (wired to `render_register_tools.prototype.list`)
*    is called by `widget_common` after a successful `load()`.
* 2. `render_content_data` builds the column header row, the datalist container,
*    an optional error banner, and initialises the submit form via `caller.init_form`.
* 3. `render_datalist` populates (or re-populates) the tool rows inside the datalist
*    container, applying visual warnings for outdated or unregistered tools.
* 4. After a successful form submit the `on_done` callback refreshes `self.value`
*    and calls `render_datalist` again in place so only the list repaints.
*
* Version columns
* ---------------
* `installed_version` and `version` are the TWO SIDES of a join and never the
* same source: the registry row vs the tool directory's register.json. When they
* disagree the registry is the stale one (it reddens), and `render_version_notice`
* prints the sentence above the table that says which number is new and that the
* Register button is the cure — a red cell in a 37-row list explains neither.
*
* WHICH rows disagree is decided ONCE, on the server (`state` / `registry_state`,
* WC-2026-08-02-register-tools-registry-state). This file and
* render_area_maintenance.js both consume that verdict; when each re-derived it
* from the raw fields, the map's copy omitted the version comparison and reported
* a green Tools node above this panel showing a red one.
*
* Visual state
* ------------
* The outer widget card label is coloured `danger` (via `set_widget_label_style`)
* when any tool has a version mismatch or when `errors` is non-empty.  The class
* is removed once everything is in sync.
*
* Column layout (6-column CSS grid, defined in register_tools.less)
* ----------------------------------------------------------------
*   Active | Name | Developer | Installed | Version | Info
*
* Server peer: core/area_maintenance/widgets/register_tools/class.register_tools.php
* Lifecycle:   core/area_maintenance/widgets/register_tools/js/register_tools.js
* Styles:      core/area_maintenance/widgets/register_tools/css/register_tools.less
*
* Public exports: render_register_tools (prototype constructor)
*/

// imports
	import {ui} from '../../../../common/js/ui.js'
	import {render_tree_data, format_label} from '../../../../common/js/common.js'
	import {set_widget_label_style} from '../../../js/render_area_maintenance.js'
	import {append_text_lines} from '../../../../common/js/utils/index.js'
	import {response_data, response_extension, request_failed} from '../../../../common/js/api_error.js'
	import {error_text} from '../../../../common/js/render_api_error.js'



/**
* RENDER_REGISTER_TOOLS
* Prototype constructor for the register_tools render layer.
*
* Instances are never created directly; their prototype methods (`list`) are copied
* onto the `register_tools` constructor in register_tools.js so the standard
* widget lifecycle (init → build → render → list/edit) works transparently.
*
* @returns {boolean} Always returns true (no-op constructor body).
*/
export const render_register_tools = function() {

	return true
}//end render_register_tools



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
*
* This is the entry point for both `edit` and `list` render modes (both prototype
* slots point here in register_tools.js).  When `render_level` is `'content'` the
* raw content_data element is returned without the outer widget wrapper, which is
* used by refresh flows that want to swap only the inner content.
*
* @param {Object} options
*   @param {string} [options.render_level="full"] - `'full'` returns the full
*     `wrapper` element; `'content'` returns only the inner `content_data` element.
*   @param {string} [options.render_mode="list"] - Render mode hint (unused here;
*     kept for interface parity with other widget render methods).
* @returns {Promise<HTMLElement>} `wrapper` (full mode) or `content_data` (content mode)
*   to be appended to the widget body node managed by area_maintenance.
*/
render_register_tools.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await render_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* RENDER_CONTENT_DATA
* Builds the full interior of the register_tools widget:
*   1. A 5-column header row (Name / Developer / Installed / Version / Info).
*   2. A `datalist_container` populated immediately by `render_datalist`.
*   3. An optional `info_text error` banner when `self.value.errors` is non-empty
*      (e.g. when the ontology is outdated and the Developer term dd1644 is missing).
*   4. A `body_response` container for API response output.
*   5. The submit form wired to `dd_area_maintenance_api::widget_request` with
*      source action `register_tools`.  On success the `on_done` callback fetches
*      fresh data and re-renders the datalist in place.
*
* The form is initialised via `self.caller.init_form` (an alias for `build_form`
* exposed on the `area_maintenance` instance).  If `self.caller` does not implement
* `init_form` (defensive check) the form is silently skipped.
*
* @param {Object} self - The `register_tools` widget instance.
*   Expected properties:
*     self.value   {Object}   — widget value object (see module header for shape).
*     self.caller  {Object}   — area_maintenance instance exposing `init_form`.
*     self.name    {string}   — widget name, used as submit button fallback label.
*     self.get_value {Function} — async method to re-fetch the widget value from the server.
* @returns {Promise<HTMLElement>} The constructed `content_data` container element.
*/
const render_content_data = async function(self) {

	// short vars
		const value		= self.value || {}
		const errors	= value.errors || []

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// tools_active
		// The live name → boolean map of the Active checkboxes. It is created ONCE
		// here and handed to the form as `trigger.options.tools_active`; the checkbox
		// listeners mutate this same object, so a submit always ships the current
		// state without rebuilding the trigger. render_datalist repopulates it on
		// every repaint (including the post-submit refresh) from the server value.
			const tools_active = {}

	// version_notice
		// The one sentence that says WHAT is wrong and WHAT fixes it. A red cell in
		// a 37-row table is a pointer, not an explanation: it never said which of
		// the two numbers was the new one, nor that pressing the button is the cure.
		// Filled (or emptied) by render_datalist on every repaint; `:empty` hides it.
			const version_notice = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'version_notice',
				parent			: content_data
			})

	// datalist
		// datalist_container holds the header row + the live tool rows; render_datalist
		// populates the rows and can replace them on subsequent calls (e.g. after
		// registration) while preserving the header (its first child).
			const datalist_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'datalist_container dd_table',
				parent			: content_data
			})

		// header
		// (!) must live INSIDE datalist_container (the .dd_table grid) so its cells
		// align to the same columns as the data rows; .dd_tr is display:contents, so a
		// header placed outside the grid collapses into a vertical stack.
			const tool_item = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_tr header',
				parent			: datalist_container
			})
			// active
			// Header cell doubles as the all/none control: one checkbox that writes
			// every enabled row at once (its indeterminate state shows a mixed set).
			const active_th = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_th active_th',
				parent			: tool_item
			})
			const check_all = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'checkbox_selector check_all',
				title			: get_label.all || 'All',
				parent			: active_th
			})
			ui.create_dom_element({
				element_type	: 'span',
				inner_html		: get_label.active || 'Active',
				parent			: active_th
			})
			check_all.addEventListener('change', function(){
				set_all_active(datalist_container, check_all.checked)
			})

			// name
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_th',
				inner_html		: get_label.name || 'Name',
				parent			: tool_item
			})

			// developer
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_th',
				inner_html		: get_label.developer || 'Developer',
				parent			: tool_item
			})

			// installed_version
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_th num',
				inner_html		: get_label.installed || 'Installed',
				parent			: tool_item
			})

			// available version
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_th num',
				inner_html		: get_label.version || 'Version',
				parent			: tool_item
			})

			// warning
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_th',
				// (!) label key is 'informacion' (Spanish legacy key); displays as 'Info'
				inner_html		: get_label.information || 'Info',
				parent			: tool_item
			})

		// summary
			// '3 disabled' counter; lives next to the submit button (appended into the
			// form below) so the consequence of the current selection is visible at the
			// exact moment of pressing it.
			const summary_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'active_summary'
			})

		// active_state
			// Everything the checkbox wiring needs, in one bag passed to render_datalist.
			const active_state = {
				tools_active	: tools_active,
				check_all		: check_all,
				summary_node	: summary_node,
				version_notice	: version_notice
			}

		// datalist rows
			render_datalist(self, datalist_container, active_state)

	// info errors
		if (errors.length) {
			// server text: text nodes + real <br>, never an HTML sink
			const errors_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text error',
				parent			: content_data
			})
			append_text_lines(errors_node, ['Errors found. Fix this errors before continue:'].concat(errors))
		}

	// body_response
		// NOTE: body_response is NOT appended to content_data here; it is added at
		// the bottom after init_form so the response area appears below the form.
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// form init
		// `self.caller.init_form` is `area_maintenance.prototype.init_form`, which
		// delegates to `build_form` in render_area_maintenance.js.
		// The trigger dispatches to `dd_area_maintenance_api` → `widget_request` →
		// `register_tools::register_tools()` (server-side), which calls
		// `tools_register::import_tools()` to write or update all tool records.
		if (self.caller?.init_form) {
			const form_container = self.caller.init_form({
				submit_label	: get_label.register_tools || self.name,
				confirm_text	: get_label.sure || 'Sure?',
				body_info		: content_data,
				body_response	: body_response,
				trigger : {
					dd_api	: 'dd_area_maintenance_api',
					action	: 'widget_request',
					prevent_lock	: true,
					source	: {
						type	: 'widget',
						model	: 'register_tools',
						action : 'register_tools'
					},
					// (!) `tools_active` is passed BY REFERENCE and mutated in place by
					// the checkbox listeners — build_form's Object.assign keeps that
					// reference, so the submit always carries the current selection.
					options	: {
						tools_active : tools_active
					}
				},
				// The import answers with one object per tool (36 × 7 fields); the
				// generic JSON tree buries the three things an admin actually needs
				// — did it work, what failed, what is now off. See render_report.
				render_response : render_report,
				on_done : async () => {

					// get and update value
					self.value = await self.get_value()

					// render datalist again
					// Re-seeds every checkbox from the registry, so what the panel shows
					// after a submit is what actually landed in dd1324.
					render_datalist(self, datalist_container, active_state)
				}
			})

			// summary next to the submit button
			form_container.appendChild(summary_node)

			// deactivate-all guard
			// The standard confirm() cannot say what is at stake; this one can. Bound
			// in the capture phase so it runs before build_form's submit handler and
			// can stop it outright.
			form_container.addEventListener('submit', (e) => {
				const names = Object.keys(tools_active)
				if (names.length && names.every((name) => tools_active[name]===false)) {
					const msg = (get_label.sure || 'Sure?') + '\n' +
						'This deactivates every tool: no tool will be available to any user.'
					if (!confirm(msg)) {
						e.preventDefault()
						e.stopImmediatePropagation()
					}
				}
			}, true)
		}

	// add at end body_response
		content_data.appendChild(body_response)


	return content_data
}//end render_content_data



/**
* RENDER_DATALIST
* Builds (or re-builds) the rows inside `datalist_container` from the current
* `self.value.datalist` array.
*
* Called once during initial render and again from the `on_done` callback after a
* successful registration request, replacing the old row nodes in place.
*
* Per-row visual logic
* --------------------
* - If `installed_version !== version` the installed-version cell receives the
*   `'warning'` CSS class (red badge), alerting the admin to re-register.
* - If either `version` or `installed_version` is falsy, a plain-text warning is
*   pushed into `ar_warning` and displayed in the Info column.
* - A server-level warning (e.g. '(!) Missing register.json') is pre-loaded from
*   `item.warning` and displayed as the first entry in `ar_warning`.
*
* Widget-card badge
* -----------------
* `set_widget_label_style(self, 'danger', …)` is called to add/remove the `danger`
* CSS class on the outer widget card label, giving a red badge whenever any tool
* needs attention.  The call is deferred to `requestAnimationFrame` internally so
* it is safe to call before `self.node` is mounted (the helper queues via
* `when_in_dom` in that case).
*
* DOM update strategy
* -------------------
* Rows are built into a `DocumentFragment` first, then the container is cleared
* with a `while/removeChild` loop (safe across all browsers) and the fragment is
* appended in a single operation, minimising reflows.
*
* @param {Object} self - The `register_tools` widget instance.
*   Expected properties:
*     self.value {Object} — current widget value (see module header for datalist shape).
*     self.node  {HTMLElement|undefined} — widget root node (may be absent on first call).
* @param {HTMLElement} datalist_container - The container element to (re-)populate.
* @param {Object} active_state - Checkbox wiring bag built by render_content_data:
*   tools_active {Object}      — live name → boolean map sent as options.tools_active.
*                                REBUILT in place on every call (the object identity
*                                must survive: the submit trigger holds this reference).
*   check_all    {HTMLElement} — the header all/none checkbox.
*   summary_node {HTMLElement} — the 'N disabled' counter next to the submit button.
* @returns {boolean} Always returns true.
*/
const render_datalist = (self, datalist_container, active_state) => {

	// short vars
		const value		= self.value || {}
		const datalist	= value.datalist || []
		const errors	= value.errors || []
		const tools_active = active_state.tools_active

	// reset tools_active
		// Mutate in place — never reassign: build_form captured this exact object.
		for (const key of Object.keys(tools_active)) {
			delete tools_active[key]
		}

	// drift
		// The card reddens on any state the Register action exists to resolve —
		// read from the server's classification, never re-derived here (the map
		// node reads the same field, so the two views cannot disagree). A tool the
		// admin deliberately deactivated is NOT a drift and never reddens the card.
		const registry	= value.registry_state || {}
		const drift		= (registry.outdated || []).length
			+ (registry.unregistered || []).length
			+ (registry.missing || []).length

	// version_notice
		// Three DISTINCT states hide behind one red cell, and each needs a different
		// action from the admin, so each gets its own sentence (only the ones that
		// actually occur are printed) — see render_version_notice.
		render_version_notice(active_state.version_notice, value)

	// set widget container label color style
		// mark the card red if there are fatal errors OR any drift
		if (errors.length || drift) {
			set_widget_label_style(self, 'danger', 'add', datalist_container)
		}else{
			set_widget_label_style(self, 'danger', 'remove', datalist_container)
		}

	const fragment = new DocumentFragment()

	const datalist_length = datalist.length
	for (let i = 0; i < datalist_length; i++) {

		const item = datalist[i]

		const name				= item.name
		const version			= item.version
		const developer			= item.developer
		const installed_version	= item.installed_version
		const on_disk			= item.on_disk !== false
		const active			= item.active !== false
		// The server's own verdict for this row: ok | outdated | unregistered |
		// missing (see the widget's ToolRegistryState). Never re-derived here.
		const state				= item.state || 'ok'
		// seed ar_warning with the server-side warning (if any); client-side checks append below
		const ar_warning		= item.warning
			? [item.warning]
			: []

		// tool_item
		const tool_item = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_tr',
			parent			: fragment
		})

		// active
		// The checkbox IS the tool's dd1354 state, not a row selector: what is on
		// screen when the button is pressed is what gets written.
		const active_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_td active_td',
			parent			: tool_item
		})
		const active_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'checkbox_selector row_active',
			parent			: active_node
		})
		active_checkbox.checked = active
		if (!on_disk) {
			// No directory ⇒ the importer never reaches this tool. Offering a live
			// checkbox here would promise a write that cannot happen.
			active_checkbox.disabled = true
			active_checkbox.title = 'Not found on disk'
		}else{
			tools_active[name] = active
			active_checkbox.addEventListener('change', function(){
				tools_active[name] = active_checkbox.checked
				tool_item.classList.toggle('inactive', !active_checkbox.checked)
				refresh_active_summary(active_state)
			})
		}
		if (!active) {
			tool_item.classList.add('inactive')
		}

		// name
		// name_td: the tool identifier is machine text — monospaced so the shared
		// `tool_` prefix lines up and the rows are scannable by their suffix.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_td name_td',
			text_content	: String(name ?? ''),
			parent			: tool_item
		})

		// developer
		// dev_td: secondary provenance (nearly always the same value), so it is
		// muted — it must not compete with the name and the versions.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_td dev_td',
			text_content	: String(developer ?? ''),
			parent			: tool_item
		})

		// installed_version
		const installed_version_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_td num',
			text_content	: String(installed_version ?? ''),
			parent			: tool_item
		})
		// The registry copy is the WRONG one when the two differ, so it is the cell
		// that reddens. Only an 'outdated' row qualifies: an empty cell painted red
		// (an unregistered tool, an orphan row) would say 'error' where the Info
		// column already says exactly what happened.
		const version_mismatch = state==='outdated'
		if (version_mismatch) {
			// state_alert, NOT alert: the bare name collides with the global .alert
			// component in layout/general.less (see widget_kit.less).
			installed_version_node.classList.add('state_alert')
		}

		// available version
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_td num',
			text_content	: String(version ?? ''),
			parent			: tool_item
		})

		// warning
		// append client-side diagnostic messages after any server-supplied warning.
		// An UNREGISTERED tool (on disk, no registry row) has no INSTALLED version by
		// definition — its 'Not registered tool' warning already says everything, so
		// the two generic version notes are suppressed as noise. (It does carry a
		// declared `version`: the server reads it from the directory's register.json.)
		const unregistered = state==='unregistered'
		// Says which number is which. 'Installed' vs 'Version' in the headers does
		// not tell an admin that the SECOND one is what the files now ship.
		if (version_mismatch) {
			// escaped: the Info cell is rendered with inner_html (the entries are
			// joined by <br>), and a version is author-supplied register.json data.
			ar_warning.push(format_label(
				get_label.tools_version_mismatch
					|| 'The registry has ${registry_version}, this tool now ships ${disk_version}',
				{
					registry_version	: escape_html(installed_version),
					disk_version		: escape_html(version)
				}
			))
		}
		if (!version && !unregistered) {
			ar_warning.push('Tool version not defined')
		}
		if (!installed_version && !unregistered) {
			ar_warning.push('Installed version not defined')
		}
		const warning_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_td',
			parent			: tool_item
		})
		if (ar_warning.length) {
			// server warning text as TEXT lines (<br> elements), never an HTML sink
			const warning_badge = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_badge state_warning',
				parent			: warning_node
			})
			append_text_lines(warning_badge, ar_warning)
		}
	}

	// clean node
	// removeChild loop is used instead of innerHTML='' to avoid triggering
	// event-listener leaks or unexpected mutation observer callbacks
	while (datalist_container.children.length > 1) {
		datalist_container.removeChild(datalist_container.lastChild);
	}

	// append
	datalist_container.appendChild(fragment)

	// sync the all/none control and the counter with the freshly seeded rows
	refresh_active_summary(active_state)


	return true
}//end render_datalist



/**
* SET_ALL_ACTIVE
* Header all/none control: writes `checked` into every ENABLED row checkbox.
*
* Rows whose tool is not on disk are skipped (their checkbox is disabled and they
* are absent from `tools_active`). Each changed node gets a synthetic `change`
* event rather than being updated directly, so the per-row listener stays the one
* place that maintains the map, the row styling and the counter.
*
* @param {HTMLElement} datalist_container - The grid holding the rows.
* @param {boolean} checked - Target state for every enabled row.
* @returns {boolean} Always returns true.
*/
const set_all_active = (datalist_container, checked) => {

	const nodes = datalist_container.querySelectorAll('input.row_active:not(:disabled)')
	for (const node of nodes) {
		if (node.checked===checked) {
			continue
		}
		node.checked = checked
		node.dispatchEvent(new Event('change'))
	}

	return true
}//end set_all_active



/**
* ESCAPE_HTML
* Minimal escape for values that reach an `inner_html` sink. Used for the
* register.json-supplied version strings in the Info column — everything else
* rendered there is a fixed literal composed in this file.
*
* @param {string} value
* @returns {string}
*/
const escape_html = (value) => String(value).replace(/[&<>"]/g, (char) => ({
	'&' : '&amp;',
	'<' : '&lt;',
	'>' : '&gt;',
	'"' : '&quot;'
}[char]))



/**
* NAME_LIST
* Joins tool names for a prose sentence, capping the enumeration so a
* whole-install drift ('34 tools are not registered') stays one readable line.
* The overflow is marked with an ellipsis, NOT with an English 'and N more':
* this string is dropped into a translated sentence.
*
* @param {Array<string>} names - tool names (registry_state carries names, not rows).
* @param {number} [max=4] - How many names to print before the ellipsis.
* @returns {string} e.g. `tool_a, tool_b, tool_c, tool_d, …`
*/
const name_list = (names, max=4) => {

	return names.length<=max
		? names.join(', ')
		: names.slice(0, max).join(', ') + ', …'
}//end name_list



/**
* RENDER_VERSION_NOTICE
* Writes the plain-language explanation above the table — the piece the red
* `installed` cell cannot give: which side is ahead, and whether the Register
* button is the fix.
*
* Reads `registry_state` (the server's own classification of the datalist), so
* the panel and the maintenance map's Tools node say the same thing by
* construction — neither re-derives 'outdated' from the raw version fields.
*
* Each state gets its own line because each has a different resolution:
*   - outdated     (the directory ships a version the registry lacks) → the button;
*   - unregistered (on disk, no registry row)                         → the button;
*   - missing      (registered, no directory) → the importer cannot reach it at
*     all, so saying 'press the button' there would be a lie.
*
* Emptied (and CSS-hidden) when the registry and the tools tree agree, so the
* panel is silent in the normal case.
*
* @param {HTMLElement|null} node - the `.version_notice` container.
* @param {Object} value - the widget value: {datalist, registry_state, errors}.
* @returns {boolean} Always returns true.
*/
const render_version_notice = (node, value) => {

	if (!node) {
		return true
	}

	// the three drift states, as the SERVER classified them
		const registry		= value.registry_state || {}
		const outdated		= registry.outdated || []
		const unregistered	= registry.unregistered || []
		const missing		= registry.missing || []
		const datalist		= value.datalist || []

	const button	= get_label.register_tools || 'Register tools'
	const lines		= []

	if (outdated.length) {
		// One row: name the two versions outright — no need to make the admin hunt
		// for the red cell to learn which side is ahead. The row is looked up by
		// name so the sentence quotes the same numbers the table shows.
		const single = outdated.length===1
			? datalist.find((item) => item.name===outdated[0])
			: null
		lines.push(single
			? format_label(
				get_label.tools_registry_outdated_one
					|| "${name} ships version ${disk_version}, but the registry still has ${registry_version}. Press '${button}' to update it.",
				{
					name				: single.name,
					disk_version		: single.version,
					registry_version	: single.installed_version,
					button				: button
				}
			)
			: format_label(
				get_label.tools_registry_outdated_many
					|| "${count} tools ship a version the registry does not have: ${names}. Press '${button}' to update it.",
				{
					count	: outdated.length,
					names	: name_list(outdated),
					button	: button
				}
			)
		)
	}

	if (unregistered.length) {
		lines.push(format_label(
			get_label.tools_not_registered_notice
				|| "Tools found on disk but not registered yet: ${names}. They stay invisible to users until you press '${button}'.",
			{
				names	: name_list(unregistered),
				button	: button
			}
		))
	}

	if (missing.length) {
		lines.push(format_label(
			get_label.tools_registry_missing_notice
				|| 'Registered tools with no files on disk: ${names}.',
			{ names : name_list(missing) }
		))
	}

	// textContent, never innerHTML: a version string is author-supplied data read
	// straight out of a register.json file, and this node is rendered for an admin.
	node.replaceChildren()
	for (const line of lines) {
		const p = document.createElement('p')
		p.textContent = line
		node.appendChild(p)
	}

	return true
}//end render_version_notice



/**
* REFRESH_ACTIVE_SUMMARY
* Recomputes the two aggregate indicators from the `tools_active` map:
*   - the header all/none checkbox (`indeterminate` when the set is mixed);
*   - the 'N disabled' counter beside the submit button (empty when none are).
*
* @param {Object} active_state - The bag described on render_datalist.
* @returns {boolean} Always returns true.
*/
const refresh_active_summary = (active_state) => {

	const values	= Object.values(active_state.tools_active)
	const total		= values.length
	const disabled	= values.filter((active) => active===false).length

	// check_all: checked when all on, indeterminate while mixed
		const check_all = active_state.check_all
		if (check_all) {
			check_all.checked		= total>0 && disabled===0
			check_all.indeterminate	= disabled>0 && disabled<total
		}

	// summary
		const summary_node = active_state.summary_node
		if (summary_node) {
			summary_node.textContent = disabled>0
				? disabled + ' ' + (get_label.disabled || 'disabled')
				: ''
		}

	return true
}//end refresh_active_summary



/**
* RENDER_REPORT
* Replaces the generic `print_response` JSON tree for the register action.
*
* The server answers with one object per tool — 36 rows × 7 fields — in which the
* three facts an administrator needs are invisible: did it work, what failed, and
* which tools are now switched off. This renders those first and keeps the raw
* response one click away.
*
*   ✓ 36 tools registered
*     34 active · 2 deactivated
*
*   Errors        per tool, always expanded (nothing else matters when present)
*   Deactivated   the names now switched off, as chips
*   Notes         warnings GROUPED by message (they repeat across tools)
*   Raw response  <details> wrapping the original tree view
*
* Wired as `render_response` on the submit form, so `print_response` never runs
* for this widget and there is no paint-then-replace flash.
*
* @param {HTMLElement} container - body_response; cleared and owned by this function.
* @param {Object} api_response - `{result, msg, errors}` where result is the
*   per-tool report array `[{name, dir, version, imported, errors, warnings, active}]`.
*   A non-array result (a refusal envelope, e.g. the ownership-gated denial) falls
*   through to the message + raw view only.
* @returns {HTMLElement} The populated container.
*/
const render_report = (container, api_response) => {

	// clean container
		while (container.firstChild) {
			container.removeChild(container.firstChild)
		}

	// button_eraser
		// Same dismiss affordance print_response provides — this renderer replaces
		// it wholesale, so it must carry it too.
		const button_eraser = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button reset eraser',
			parent			: container
		})
		button_eraser.addEventListener('mouseup', function(e){
			e.stopPropagation()
			while (container.firstChild) {
				container.removeChild(container.firstChild)
			}
		})

	// short vars
		const report_data	= response_data(api_response)
		const report		= Array.isArray(report_data) ? report_data : []
		const api_errors	= response_extension(api_response, 'errors') || []

	// report_node
		const report_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'register_report',
			parent			: container
		})

	// non-report envelope (refusal / error): show the message and stop
		if (!report.length) {
			// server text as TEXT lines (<br> elements), never an HTML sink
			const message_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: api_errors.length ? 'api_response error' : 'api_response',
				parent			: report_node
			})
			append_text_lines(
				message_node,
				api_errors.length
					? api_errors
					: [request_failed(api_response)
						? error_text(api_response.error)
						: (response_extension(api_response, 'msg') || 'Unknown API response error')]
			)
			render_raw(report_node, api_response)
			return container
		}

	// counts
		const failed		= report.filter((item) => item.errors && item.errors.length)
		const imported		= report.filter((item) => item.imported)
		const deactivated	= report.filter((item) => item.active===false)
		const ok			= failed.length===0

	// headline
		const headline = ui.create_dom_element({
			element_type	: 'div',
			// state_* rather than bare ok/failed: .body_response applies the kit's
			// .dd_response_states(), whose generic .ok/.error rules would capture
			// these nodes (and did — a stray green rule + display:block).
			class_name		: 'report_headline ' + (ok ? 'state_ok' : 'state_failed'),
			parent			: report_node
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'report_icon',
			inner_html		: ok ? '✓' : '!',
			parent			: headline
		})
		const tools_registered = get_label.tools_registered || 'tools registered'
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'report_title',
			text_content	: ok
				? imported.length + ' ' + tools_registered
				: imported.length + '/' + report.length + ' ' + tools_registered + ' · ' +
					failed.length + ' ' + (get_label.with_errors || 'with errors'),
			parent			: headline
		})

	// counters
		// active/deactivated is the state the admin just wrote; say it plainly even
		// when nothing was switched off, so the line always confirms the outcome.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'report_counters',
			text_content	: (report.length - deactivated.length) + ' ' + (get_label.active || 'Active').toLowerCase() +
				' · ' + deactivated.length + ' ' + (get_label.disabled || 'disabled'),
			parent			: report_node
		})

	// errors
		if (failed.length) {
			const errors_block = render_block(report_node, get_label.errors || 'Errors', 'errors')
			for (let i = 0; i < failed.length; i++) {
				const item = failed[i]
				const row = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'report_row',
					parent			: errors_block
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'report_tool',
					text_content	: String(item.name ?? ''),
					parent			: row
				})
				// per-tool server error text as TEXT lines, never an HTML sink
				const detail_node = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'report_detail',
					parent			: row
				})
				append_text_lines(detail_node, item.errors)
			}
		}

	// deactivated
		if (deactivated.length) {
			const deactivated_block = render_block(report_node, get_label.deactivated || 'Deactivated', 'deactivated')
			const chips = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'report_chips',
				parent			: deactivated_block
			})
			for (let i = 0; i < deactivated.length; i++) {
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'dd_badge',
					text_content	: String(deactivated[i].name ?? ''),
					parent			: chips
				})
			}
		}

	// notes
		// Warnings repeat verbatim across tools ('no server module: …' on every
		// tool without one), so they are grouped by message with their tool list.
		const groups = new Map()
		for (let i = 0; i < report.length; i++) {
			const item = report[i]
			const warnings = item.warnings || []
			for (let j = 0; j < warnings.length; j++) {
				const key = warnings[j]
				if (!groups.has(key)) {
					groups.set(key, [])
				}
				groups.get(key).push(item.name)
			}
		}
		if (groups.size) {
			const notes_block = render_block(report_node, get_label.notes || 'Notes', 'notes')
			for (const [message, names] of groups) {
				const row = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'report_row note_row',
					parent			: notes_block
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'report_tool',
					text_content	: names.length + '×',
					parent			: row
				})
				const detail = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'report_detail',
					text_content	: String(message ?? ''),
					parent			: row
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'report_names',
					text_content	: names.join(', '),
					parent			: detail
				})
			}
		}

	// raw
		render_raw(report_node, api_response)


	return container
}//end render_report



/**
* RENDER_BLOCK
* One titled section of the report (Errors / Deactivated / Notes).
*
* @param {HTMLElement} parent - The report container.
* @param {string} title - Section heading text.
* @param {string} modifier - Extra class name identifying the section.
* @returns {HTMLElement} The section's body node, to append rows into.
*/
const render_block = (parent, title, modifier) => {

	const block = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'report_block ' + modifier,
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'report_block_title',
		inner_html		: title,
		parent			: block
	})

	return ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'report_block_body',
		parent			: block
	})
}//end render_block



/**
* RENDER_RAW
* Collapsed `<details>` holding the untouched API response tree — the view
* print_response would have shown. Kept because a per-tool field (dir, version,
* the exact error text) is occasionally what an admin needs.
*
* @param {HTMLElement} parent - The report container.
* @param {Object} api_response - The full response object.
* @returns {HTMLElement} The details element.
*/
const render_raw = (parent, api_response) => {

	const details = ui.create_dom_element({
		element_type	: 'details',
		class_name		: 'report_raw',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'summary',
		inner_html		: get_label.raw_response || 'Raw response',
		parent			: details
	})
	const pre = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'pre',
		parent			: details
	})
	render_tree_data(api_response, pre)

	return details
}//end render_raw



// @license-end
