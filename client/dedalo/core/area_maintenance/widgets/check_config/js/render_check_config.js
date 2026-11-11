// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_CHECK_CONFIG
*
* Client-side rendering module for the `check_config` maintenance widget.
*
* Purpose
* -------
* The check_config widget audits the live v7 installation's configuration and
* surfaces two readout cards:
*
*   - Database connection — the live DB status from `installer::get_db_status()`:
*                           a real connection + write probe plus the credential
*                           placeholder checks.
*   - Config sources      — presence/readability of the files that actually drive
*                           a v7 install (`../private/.env`, `../private/state.php`
*                           and the optional `../private/config.local.php`).
*
* Note: earlier revisions also diffed the running process against the shipped
* `sample.config*.php` templates and listed undefined constants. Those web-served
* config files are no longer part of the v7 configuration flow (constants are
* emitted from .env + state.php + the catalog), so that section was removed.
*
* Root-only controls (visible only when `page_globals.is_root === true`)
* -----------------------------------------------------------------------
*   - Maintenance mode  — toggles `DEDALO_MAINTENANCE_MODE`; non-root users are
*                         kicked out and cannot log in while this is active.
*   - Recovery mode     — toggles the Ontology backup table as the active Ontology
*                         table, useful after a failed migration.
*   - Notification      — sets or clears a `DEDALO_NOTIFICATION` banner that is
*                         injected into every user's page via the component
*                         activation/deactivation API (`update_lock_components_state`).
*
* Data contract (server → client)
* --------------------------------
* `self.value` is the `result` object returned by `check_config::get_value()`:
*   {
*     db_status      : {Object}  per-check booleans + global_status (see installer::get_db_status)
*     config_sources : {Array}   [{ name, required, exists, readable }] for ../private files
*     db_info        : {Object?} TS-native, OPTIONAL: { identity, server, schema_ok,
*                                ontology_rows, matrix_tables, migration_level,
*                                migration_latest, pool:{in_use,max,waiters} }
*     runtime_mode   : {Object?} TS-native, OPTIONAL: { maintenance, recovery,
*                                notification, diffusion_native, dev_mode }
*   }
* The two OPTIONAL blocks are rendered only when present (the PHP oracle payload
* omits them), so this renderer degrades cleanly on the PHP client.
*
* Widget card label style
* -----------------------
* When `db_status.global_status` is not true, or a required `config_sources` entry
* is missing/unreadable, the module calls `set_widget_label_style(self, 'danger',
* 'add', …)` so the card header turns red, alerting the administrator.
*
* Architecture
* ------------
* This file exports only `render_check_config` (prototype constructor).
* `check_config.js` assigns `render_check_config.prototype.list` onto
* `check_config.prototype.edit` and `check_config.prototype.list` so that
* the standard lifecycle (`init → build → render`) flows through here.
*
* All DOM construction is delegated to private module-level functions:
*   get_content_data_edit       — top-level layout builder
*   add_status_row              — one key/value row in a .dd_readout grid
*   render_config_vars_status   — DB connection + config-source status cards
*   render_maintenance_mode     — maintenance mode toggle form
*   render_recovery_mode        — recovery mode toggle form
*   render_notification         — notification banner form
*
* Server peer:  core/area_maintenance/widgets/check_config/class.check_config.php
* Lifecycle:    core/area_maintenance/widgets/check_config/js/check_config.js
* API:          dd_area_maintenance_api → get_widget_value → check_config::get_value
*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {dd_request_idle_callback} from '../../../../common/js/events.js'
	import {set_widget_label_style} from '../../../js/render_area_maintenance.js'
	import {request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {handle_api_error} from '../../../../common/js/error_dispatch.js'



/**
* RENDER_CHECK_CONFIG
* Prototype constructor for the check_config widget render module.
*
* The constructor is a no-op; all rendering logic lives in the prototype
* method `list` (assigned as both `edit` and `list` on `check_config`).
* Never instantiate this directly — always use through a `check_config` instance.
*
* @returns {boolean} Always true (no-op constructor marker)
*/
export const render_check_config = function() {

	return true
}//end render_check_config



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
*
* Builds the full widget DOM tree when `render_level === 'full'`, or returns
* only the raw `content_data` element when `render_level === 'content'` (used
* by `common.prototype.refresh` for an efficient in-place content swap).
*
* @param {Object} options - Render options forwarded by the lifecycle caller
* @param {string} [options.render_level='full'] - 'full' returns the outer wrapper;
*   'content' returns only the inner content_data element
* @returns {Promise<HTMLElement>} Widget wrapper (render_level='full') or content_data
*   element (render_level='content') to be appended to the widget body node in
*   area_maintenance
*/
render_check_config.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
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
* GET_CONTENT_DATA_EDIT
* Builds the top-level content DOM for the check_config widget.
*
* Layout:
*   - Root-only section (guarded by `page_globals.is_root === true`):
*       1. Maintenance mode toggle form
*       2. Recovery mode toggle form
*       3. Notification banner form
*   - Config vars status cards (always visible):
*       A div wrapping the output of `render_config_vars_status`, which shows the
*       database connection status and the ../private config-source presence.
*
* @param {Object} self - The `check_config` widget instance; must expose
*   `self.value` (the server-side audit result object) and
*   `self.caller` (the parent area_maintenance instance providing `init_form`)
* @returns {Promise<HTMLElement>} The assembled content_data div
*/
const get_content_data_edit = async function(self) {

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// maintenance_mode, recovery_mode, notification
	// root only
		if (page_globals.is_root===true) {

			// maintenance_mode
				const maintenance_mode_container = render_maintenance_mode(self)
				content_data.appendChild(maintenance_mode_container)

			// recovery_mode
				const recovery_mode_container = render_recovery_mode(self)
				content_data.appendChild(recovery_mode_container)

			// notification
				const notification_container = render_notification(self)
				content_data.appendChild(notification_container)

		}//end if (page_globals.is_root===true)

	// config vars status
	// config_vars_status_container
		const config_vars_status_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'config_vars_status_container',
			parent			: content_data
		})
		const config_vars_node = render_config_vars_status(self)
		config_vars_status_container.appendChild(config_vars_node)


	return content_data
}//end get_content_data_edit



/**
* ADD_STATUS_ROW
* Appends one key/value row to a shared-kit `.dd_readout` grid.
*
* Emits the canonical kit markup — `.dd_row` (display:contents) wrapping a `.dd_k`
* uppercase key cell and a `.dd_v` value cell whose inner `.dd_badge` carries the
* severity chip, so the chip hugs its own text instead of stretching the grid cell.
*
* The value is written via `.textContent` (never parsed as HTML); the label is a
* trusted in-code string set as innerHTML.
*
* @param {HTMLElement} parent      - the `.dd_readout` container
* @param {string}      label       - field name (trusted; set as innerHTML)
* @param {string}      value_text  - field value (set as textContent)
* @param {string}      [state_class=''] - kit chip token, e.g. 'state_ok' |
*   'state_danger' | 'state_warning' | 'mono'
* @returns {HTMLElement} the created `.dd_row`
*/
const add_status_row = function(parent, label, value_text, state_class='') {

	const row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_row',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_k',
		inner_html		: label,
		parent			: row
	})
	const value_node = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_v',
		parent			: row
	})
	const value_badge = ui.create_dom_element({
		element_type	: 'span',
		class_name		: ('dd_badge ' + state_class).trim(),
		parent			: value_node
	})
	value_badge.textContent = value_text

	return row
}//end add_status_row



/**
* RENDER_CONFIG_VARS_STATUS
* Create the necessary DOM nodes to display the v7 config status.
*
* Reads `self.value` (the object returned by check_config::get_value) and renders
* two stacked readout cards using the shared area_maintenance kit
* (`.dd_eyebrow` section heading + `.dd_readout` grid + `.dd_badge` severity chips):
*
*   Database connection — per-check rows from `db_status` (live connection, write
*     probe, and the credential placeholder checks). Each row is a calm green
*     `state_ok` chip when healthy, or a red `state_danger` chip with a short
*     reason when it fails.
*
*   Config sources (../private) — presence/readability of the files that actually
*     drive a v7 install (.env, state.php and the optional config.local.php). A
*     required source that is missing/unreadable is `state_danger`; an optional
*     source that is simply absent stays calm (neutral `mono` chip, no colour).
*
* Side effect: if `db_status.global_status` is not true, or a required private
* config source is missing/unreadable, the widget card header is coloured red via
* `set_widget_label_style(self, 'danger', 'add', …)`. This uses a `when_in_dom`
* deferred call (inside `set_widget_label_style`) because the fragment may not yet
* be attached to the live DOM.
*
* @param {Object} self - The `check_config` widget instance
* @returns {DocumentFragment} Fragment containing the full status UI
*/
const render_config_vars_status = function (self) {

	// value (v7 object shape: { db_status, config_sources })
	const value = self.value || {};

	const fragment = new DocumentFragment();

	// status_sections — reference node for the when_in_dom widget-label style toggle
		const status_sections = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_sections',
			parent			: fragment
		})

	// ---- database connection status ----
		const db_status = value.db_status || {}
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_eyebrow',
			inner_html		: 'Database connection',
			parent			: status_sections
		})
		const db_readout = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_readout',
			parent			: status_sections
		})
		// [ label, ok_boolean, fail_text ] — fail_text explains what an Error means
		const db_checks = [
			['Connection',		db_status.db_connection_check,		'Failed'],
			['Writable',		db_status.db_writable_check,		'Not writable'],
			['Database name',	db_status.config_db_name_check,		'Sample placeholder'],
			['User name',		db_status.config_user_name_check,	'Sample placeholder'],
			['Password',		db_status.config_pw_check,			'Sample placeholder'],
			['Information',		db_status.config_information_check,	'Not set'],
			['Info key',		db_status.config_info_key_check,	'Not set']
		]
		for (let i = 0; i < db_checks.length; i++) {
			const ok = db_checks[i][1]===true
			add_status_row(
				db_readout,
				db_checks[i][0],
				ok ? (get_label.ok || 'OK') : db_checks[i][2],
				ok ? 'state_ok' : 'state_danger'
			)
		}

	// ---- database details (identity / engine / schema / migrations / pool) ----
	// TS-native enrichment (WC-027): rendered ONLY when the server supplies `db_info`.
	// The PHP oracle payload omits it, so these rows simply do not appear there — the
	// renderer degrades to the original card with no change on the PHP client.
		const db_info = value.db_info
		if (db_info) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_eyebrow',
				inner_html		: 'Database details',
				parent			: status_sections
			})
			const details_readout = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_readout',
				parent			: status_sections
			})
			// which database this server is ACTUALLY wired to (name@host:port) — the
			// "am I on staging or prod?" confirmation the widget existed to give.
			add_status_row(details_readout, 'Database', db_info.identity || '—', 'mono')
			// postgres engine + version
			if (db_info.server) {
				add_status_row(details_readout, 'Server', db_info.server, 'mono')
			}
			// schema health: ontology present + matrix tables materialised. A live
			// connection to an EMPTY/half-migrated DB used to read as fully "OK".
			if (db_info.schema_ok!==null && db_info.schema_ok!==undefined) {
				const parts = []
				if (db_info.ontology_rows!==null && db_info.ontology_rows!==undefined) {
					parts.push(db_info.ontology_rows + ' ontology rows')
				}
				if (db_info.matrix_tables!==null && db_info.matrix_tables!==undefined) {
					parts.push(db_info.matrix_tables + ' matrix tables')
				}
				const detail_txt = parts.length ? parts.join(', ') : ''
				const schema_text = db_info.schema_ok
					? (detail_txt || (get_label.ok || 'OK'))
					: ('Incomplete' + (detail_txt ? ' (' + detail_txt + ')' : ''))
				add_status_row(details_readout, 'Schema', schema_text, db_info.schema_ok ? 'state_ok' : 'state_danger')
			}
			// TS-owned schema migration level (count applied + latest filename)
			if (db_info.migration_level!==null && db_info.migration_level!==undefined) {
				const mig_text = db_info.migration_level + ' applied'
					+ (db_info.migration_latest ? ' — ' + db_info.migration_latest : '')
				add_status_row(details_readout, 'Migrations', mig_text, 'mono')
			}
			// live connection-pool utilisation (saturation = a warning chip)
			if (db_info.pool) {
				const in_use	= db_info.pool.in_use
				const max		= db_info.pool.max
				const saturated	= (max>0 && in_use>=max)
				let pool_text	= in_use + ' / ' + max + ' in use'
				if (db_info.pool.waiters>0) {
					pool_text += ' (' + db_info.pool.waiters + ' waiting)'
				}
				add_status_row(details_readout, 'Pool', pool_text, saturated ? 'state_warning' : 'mono')
			}
		}

	// ---- runtime mode (maintenance / recovery / notification / engine flags) ----
	// TS-native enrichment (WC-027): a read-only "what mode am I in" strip, visible to
	// EVERY admin (the root-only forms above only TOGGLE the first three). Guarded on
	// `runtime_mode`, so the PHP client renders unchanged.
		const runtime_mode = value.runtime_mode
		if (runtime_mode) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_eyebrow',
				inner_html		: 'Runtime mode',
				parent			: status_sections
			})
			const mode_readout = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_readout',
				parent			: status_sections
			})
			// an ACTIVE maintenance/recovery/notification is an unusual state worth a
			// warning chip; OFF is the calm normal (neutral mono chip).
			const on_off = (active) => active ? 'state_warning' : 'mono'
			add_status_row(mode_readout, 'Maintenance mode', runtime_mode.maintenance ? 'On' : 'Off', on_off(runtime_mode.maintenance))
			add_status_row(mode_readout, 'Recovery mode', runtime_mode.recovery ? 'On' : 'Off', on_off(runtime_mode.recovery))
			add_status_row(mode_readout, 'Notification', runtime_mode.notification ? 'Active' : 'Off', on_off(runtime_mode.notification))
			// engine flags are neutral facts, not alarms → mono chip
			add_status_row(mode_readout, 'Diffusion engine', runtime_mode.diffusion_native ? 'Native (TS)' : 'PHP', 'mono')
			add_status_row(mode_readout, 'Dev mode', runtime_mode.dev_mode ? 'On' : 'Off', runtime_mode.dev_mode ? 'state_warning' : 'mono')
		}

	// ---- private config sources (../private) ----
		const config_sources = value.config_sources || []
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_eyebrow',
			inner_html		: 'Config sources (../private)',
			parent			: status_sections
		})
		const sources_readout = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_readout',
			parent			: status_sections
		})
		for (let i = 0; i < config_sources.length; i++) {
			const source = config_sources[i]
			// readable → OK; required & not readable → danger; optional & absent → calm
			let state_text
			let state_class
			if (source.readable===true) {
				state_text	= get_label.ok || 'OK'
				state_class	= 'state_ok'
			}else if (source.exists===true) {
				state_text	= 'Not readable'
				state_class	= 'state_danger'
			}else if (source.required===true) {
				state_text	= 'Missing'
				state_class	= 'state_danger'
			}else{
				// optional source simply absent — no action needed, stay calm
				state_text	= 'Not set (optional)'
				state_class	= 'mono'
			}
			add_status_row(sources_readout, source.name, state_text, state_class)
		}

	// Widget label header style: red (danger) when the DB status is not fully OK
	// or a required private config source is missing/unreadable.
		const db_ok		= db_status.global_status===true
		const sources_ok	= config_sources.every(s => s.readable===true || s.required===false)
		if (!db_ok || !sources_ok) {
			set_widget_label_style(self, 'danger', 'add',
				status_sections // reference node to attach in when_in_dom event
			)
		}else{
			set_widget_label_style(self, 'danger', 'remove',
				status_sections // reference node to attach in when_in_dom event
			)
		}


	return fragment;
}//end render_config_vars_status



/**
* RENDER_MAINTENANCE_MODE
* Creates the form nodes to switch between maintenance modes
*
* Renders a labelled container with a submit form (built via `self.caller.init_form`)
* that toggles the server-side `DEDALO_MAINTENANCE_MODE` flag.
*
* Behaviour
* ---------
* - The submit button label reflects the current state: "Activate" when the mode is
*   off, "Deactivate" when on.
* - When maintenance mode is currently OFF the submit button receives the CSS class
*   `danger` (red) to warn the operator before activating it.
* - On successful API response (a truthy payload) `page_globals.maintenance_mode`
*   is updated in-place and the page is refreshed via `dd_request_idle_callback` so
*   all widgets re-render with the new flag state without a full navigation.
* - The `trigger` object (rather than `on_submit`) is used here, meaning `build_form`
*   handles the API call internally; `on_done` is the post-response hook.
*
* Guard: if `self.caller.init_form` is falsy (e.g. widget loaded outside a full
* area_maintenance context) the form block is silently skipped; only the label and
* the warning body_response are rendered.
*
* @param {Object} self - The `check_config` widget instance; `self.caller` must expose
*   `init_form` (the `build_form` wrapper set up in `area_maintenance`)
* @returns {HTMLElement} The assembled maintenance_mode_container div
*/
const render_maintenance_mode = (self) => {

	const maintenance_mode_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container maintenance_mode_container',
	})

	// label
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label',
		inner_html		: 'maintenance mode',
		parent			: maintenance_mode_container
	})

	// body_response warning
	const maintenance_mode_body_response = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'body_response'
	})

	// form
	if (self.caller?.init_form) {
		const submit_label = page_globals.maintenance_mode===true
			? 'Deactivate maintenance mode'
			: 'Activate maintenance mode'
		const new_maintenance_mode = !page_globals.maintenance_mode
		const form_container = self.caller.init_form({
			submit_label	: submit_label,
			confirm_text	: get_label.sure || 'Sure?',
			body_info		: maintenance_mode_container,
			body_response	: maintenance_mode_body_response,
			trigger : {
				dd_api	: 'dd_area_maintenance_api',
				action	: 'widget_request',
				source	: {
					type : 'widget',
					model : 'check_config',
					action : 'set_maintenance_mode'
				},
				options	: {
					value : new_maintenance_mode

				}
			},
			on_done : (api_response) => {
				if (request_failed(api_response)===false && response_data(api_response)) {
					dd_request_idle_callback(
						() => {
							// update page_globals value
							page_globals.maintenance_mode = new_maintenance_mode
							// render the page again
							window.dd_page.refresh({
								build_autoload	: false,
								destroy			: false
							})
						}
					)
				}
			}
		})
		if (page_globals.maintenance_mode===false) {
			form_container.button_submit.classList.add('danger')
		}
	}

	// warning_message
	const warning_message = ui.create_dom_element({
		element_type	: 'div',
		inner_html		: "Warning! On true, users other than 'root' will be kicked and will not be able to login in this mode.",
		class_name		: 'warning_message',
		parent			: maintenance_mode_container
	})

	// add maintenance_mode_body_response at end
	maintenance_mode_container.appendChild(maintenance_mode_body_response)


	return maintenance_mode_container
}//end render_maintenance_mode



/**
* RENDER_RECOVERY_MODE
* Creates the form nodes to switch between recovery modes
*
* Renders a labelled container with a submit form (built via `self.caller.init_form`)
* that toggles the server-side recovery mode flag. In recovery mode the Ontology
* backup table is used instead of the main Ontology table, allowing the system to
* stay operational after a failed migration.
*
* Behaviour
* ---------
* - The submit button label reflects the current state: "Activate" when the mode is
*   off, "Deactivate" when on.
* - When recovery mode is currently OFF the submit button receives the CSS class
*   `danger` (red) as a visual warning.
* - On successful API response (a truthy payload) `page_globals.recovery_mode`
*   is updated in-place, the page is refreshed via `dd_request_idle_callback`, and the
*   URL is cleaned up by stripping any `recovery` query parameter that may have been
*   injected by a previous recovery-triggered redirect — otherwise the recovery param
*   would re-trigger recovery mode on the next page load.
* - The `trigger` object (rather than `on_submit`) is used, so `build_form` handles the
*   API call internally; `on_done` is the post-response hook.
*
* Guard: if `self.caller.init_form` is falsy the form block is silently skipped.
*
* @param {Object} self - The `check_config` widget instance; `self.caller` must expose
*   `init_form` (the `build_form` wrapper set up in `area_maintenance`)
* @returns {HTMLElement} The assembled recovery_mode_container div
*/
const render_recovery_mode = (self) => {

	const recovery_mode_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container recovery_mode_container',
	})

	// label
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label',
		inner_html		: 'recovery mode',
		parent			: recovery_mode_container
	})

	// body_response warning
	const recovery_mode_body_response = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'body_response'
	})

	// form
	if (self.caller?.init_form) {
		const submit_label = page_globals.recovery_mode===true
			? 'Deactivate recovery mode'
			: 'Activate recovery mode'
		const new_recovery_mode = !page_globals.recovery_mode
		const form_container = self.caller.init_form({
			submit_label	: submit_label,
			confirm_text	: get_label.sure || 'Sure?',
			body_info		: recovery_mode_container,
			body_response	: recovery_mode_body_response,
			trigger : {
				dd_api	: 'dd_area_maintenance_api',
				action	: 'widget_request',
				source	: {
					type : 'widget',
					model : 'check_config',
					action : 'set_recovery_mode'
				},
				options	: {
					value : new_recovery_mode

				}
			},
			on_done : (api_response) => {
				if (response_data(api_response)) {
					dd_request_idle_callback(
						() => {
							// update page_globals value
							page_globals.recovery_mode = new_recovery_mode
							// render the page again
							window.dd_page.refresh({
								build_autoload	: false,
								destroy			: false
							})
							// refresh URL (remove possible recovery param to prevent infinite loop)
							const URL = window.location.href.split("recovery")[0];
							window.history.pushState({}, document.title, URL );
						}
					)
				}
			}
		})
		if (page_globals.recovery_mode===false) {
			form_container.button_submit.classList.add('danger')
		}
	}

	// warning_message
	const warning_message = ui.create_dom_element({
		element_type	: 'div',
		inner_html		: "Warning! On true, Ontology backup table will be used instead the main Ontology table.",
		class_name		: 'warning_message',
		parent			: recovery_mode_container
	})

	// add recovery_mode_body_response at end
	recovery_mode_container.appendChild(recovery_mode_body_response)


	return recovery_mode_container
}//end render_recovery_mode



/**
* RENDER_NOTIFICATION
* Creates the form nodes to send user notifications
* Note that this custom notifications are stored in core_config file
* and read from API update_lock_components_state on every component activation/deactivation
*
* Renders a labelled container with a form (built via `self.caller.init_form`) that
* sets or clears a global `DEDALO_NOTIFICATION` banner displayed to all users on every
* component activation/deactivation poll.
*
* Shape of `page_globals.dedalo_notification` when active:
*   { msg: {string}, class_name: {string} }  e.g. { msg: 'Planned downtime at 18:00', class_name: 'warning' }
* When inactive: `false`.
*
* PHP sample declaration (for reference only):
*   define('DEDALO_NOTIFICATION', ['msg' => $notice, 'class_name' => 'warning']);
*
* Behaviour
* ---------
* - When no notification is active a text input is shown for the message, and the
*   `mandatory` flag is set so the form refuses to submit without content.
* - When a notification is already active the text input is omitted; submitting
*   removes the notification (sends `value: false` to the API).
* - `on_submit` is used here (instead of `trigger`) so the module can issue the API
*   call directly via `data_manager.request` with a 1-hour timeout and `retries: 1`,
*   appropriate for a long-running config write operation.
* - `notification_value` is either the typed message string (activate) or `false`
*   (deactivate). On success `page_globals.dedalo_notification` is updated in-place
*   to the normalised object form or `false`, and the page is refreshed via
*   `dd_request_idle_callback`.
* - On failure an error div is appended to `notification_body_response`.
*
* Guard: if `self.caller.init_form` is falsy the form block is silently skipped.
*
* @param {Object} self - The `check_config` widget instance; `self.caller` must expose
*   `init_form` (the `build_form` wrapper set up in `area_maintenance`)
* @returns {HTMLElement} The assembled notification_container div
*/
const render_notification = (self) => {

	const notification_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container'
	})

	// label
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label',
		inner_html		: 'Notification',
		parent			: notification_container
	})

	const dedalo_notification = page_globals.dedalo_notification ?? false;

	// body response
	const notification_body_response = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'body_response'
	})
	// sample: define('DEDALO_NOTIFICATION', ['msg' => $notice, 'class_name' => 'warning']);

	// form
	if (self.caller?.init_form) {
		const submit_label = !dedalo_notification
			? 'Activate notification'
			: 'Remove notification'

		self.caller.init_form({
			submit_label	: submit_label,
			confirm_text	: get_label.sure || 'Sure?',
			body_info		: notification_container,
			body_response	: notification_body_response,
			// inputs are shown only when activating (no current notification);
			// when deactivating, no input is needed — the API call uses value: false
			inputs			: (dedalo_notification===false)
				? [{
					type		: 'text',
					name		: 'notification_text',
					label		: 'Message here..',
					mandatory	: (dedalo_notification===false)
				  }]
				: null,
			on_submit : async (e, values) => {

				const input				= values.find(el => el.name==='notification_text')
				const notification_text	= input?.value // string like 'My custom notification'

				// activate: send message string; deactivate: send false
				const notification_value = dedalo_notification===false
					? notification_text
					: false

				const api_response = await data_manager.request({
					body : {
						dd_api			: 'dd_area_maintenance_api',
						action			: 'widget_request',
						prevent_lock	: true,
						source			: {
							type : 'widget',
							model : 'check_config',
							action : 'set_notification',
						},
						options : {
							value	: notification_value // string|false
						}
					},
					retries : 1, // one try only
					timeout : 3600 * 1000 // 1 hour waiting response
				})
				if(SHOW_DEBUG===true) {
					console.log('debug set_notification api_response:', api_response);
				}

				if (response_data(api_response)) {
					// update page_globals value
					page_globals.dedalo_notification = notification_value===false
						? false
						: {
							msg			: notification_value,
							class_name	: 'warning'
						  }
					// render the page again
					dd_request_idle_callback(
						() => {
							window.dd_page.refresh({
								build_autoload	: false,
								destroy			: false
							})
						}
					)
				}else if (request_failed(api_response)) {
					// ONE error model: policy + renderer decide the surface
					await handle_api_error(api_response.error, {wrapper: notification_body_response})
				}else{
					// server text as TEXT, never an HTML sink
					const error_txt = response_extension(api_response, 'msg') || 'Error setting notification_value (unknown)'
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error',
						text_content	: String(error_txt),
						parent			: notification_body_response
					})
				}
			}
		})
	}

	// warning_message
	const warning_message = ui.create_dom_element({
		element_type	: 'div',
		text_content	: "Notification: " + JSON.stringify(dedalo_notification, null, 2),
		class_name		: 'warning_message',
		parent			: notification_container
	})

	// add notification_body_response at end
	notification_container.appendChild(notification_body_response)


	return notification_container
}//end render_notification



// @license-end
