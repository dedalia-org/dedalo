// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_UPDATE_DATA_VERSION
* Client-side render module for the update_data_version maintenance widget.
*
* This module provides the administrator UI for incrementing the Dédalo data
* format version — a destructive, potentially long-running operation that migrates
* all stored component data from one internal format to another
* (e.g. from data version 5.8.2 to 6.0.0).
*
* Overview of the update process
* --------------------------------
* The server maintains a set of versioned migration descriptors in
* `class.update.php::get_updates()`.  Each descriptor bundle is keyed by the
* target version string and may contain any combination of the following step
* types:
*   - `alert_update`      — Human-readable warning/notification rendered as <h2>
*                           before the step list; may contain inline <code> blocks
*                           syntax-highlighted by highlight.js (PHP grammar).
*   - `SQL_update`        — Raw SQL statements to execute against the Dédalo DB.
*   - `components_update` — Component tipo identifiers whose stored dato must be
*                           rewritten by the server migration logic.
*   - `run_scripts`       — Arbitrary PHP script paths executed server-side.
*
* Each actionable step is rendered with a checkbox so the administrator can
* selectively include or exclude individual steps.  The resulting checked map
* (`updates_checked`) is sent to the server when the form is submitted.
*
* Safety gates
* ------------
* Two server-side guards are enforced and also reflected in the UI:
*   1. Only the root (superuser) account (`page_globals.is_root === true`) may
*      execute the update.
*   2. Dédalo must be running in maintenance_mode (`page_globals.maintenance_mode === true`).
* When either condition is not met the submit button is withheld and a warning
* message is shown in its place.
* A third condition, `updates.lock === true`, suppresses the button when the
* server signals that the update bundle is locked (e.g. already in progress).
*
* Long-running background execution
* ----------------------------------
* The API call fires the migration as a CLI background process
* (`background_running: true`) and immediately returns a `{pid, pfile}` handle.
* Progress is then tracked via `update_process_status`, which opens an SSE stream
* from the server process-status API and renders live output into `body_response`.
* The handle is also persisted to IndexedDB (key `'process_update_data_version'`)
* so that re-mounting the widget (e.g. after a page reload) can re-attach to an
* already-running migration via `check_process_data`.
*
* Architecture notes
* -------------------
*   - The constructor is a no-op stub; all rendering behaviour is provided via
*     prototype assignments in `update_data_version.js`.
*   - `render_update_data_version.prototype.list` is aliased to both
*     `update_data_version.prototype.list` and `update_data_version.prototype.edit`
*     in `update_data_version.js`, so it handles both render modes.
*   - `self.caller` is the parent `area_maintenance` instance;
*     `self.caller?.init_form` delegates to `render_area_maintenance::build_form`
*     to wire the submit button and confirmation gate into the widget body.
*   - The widget card label is styled with the 'danger' colour theme when an
*     update is pending, making the state immediately visible in the dashboard.
*   - highlight.js is imported with the PHP language pack specifically to
*     syntax-highlight <code> blocks that may appear inside `alert_update` items.
*
* Server peer:  core/area_maintenance/widgets/update_data_version/class.update_data_version.php
* Lifecycle:    update_data_version.js (init / build / render / refresh / destroy)
* API action:   dd_area_maintenance_api → widget_request → update_data_version
*
* Exports: render_update_data_version
*
* @module render_update_data_version
*/

// imports
	import {ui} from '../../../../common/js/ui.js'
	import {when_in_dom} from '../../../../common/js/events.js'
	import {update_process_status} from '../../../../common/js/common.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {login} from '../../../../login/js/login.js'
	import {set_widget_label_style} from '../../../js/render_area_maintenance.js'
	import {render_maintenance_prereq} from '../../../js/maintenance_mode.js'

	// hljs
	import hljs from '../../../../../lib/highlightjs/es/core.min.js';
	import php from '../../../../../lib/highlightjs/es/languages/php.min.js';
	hljs.registerLanguage('php', php);



/**
* RENDER_UPDATE_DATA_VERSION
* Constructor stub for the render_update_data_version prototype chain.
* All rendering behaviour is provided via prototype assignments in update_data_version.js.
*/
export const render_update_data_version = function() {

	return true
}//end render_update_data_version



/**
* LIST
* Builds and returns the full widget DOM tree for the update_data_version UI.
*
* When render_level is 'content', returns just the inner content_data element
* (used when the caller only needs to refresh the body without re-wrapping).
* Otherwise builds and returns the full widget wrapper produced by
* ui.widget.build_wrapper_edit, which includes the standard widget chrome
* (title bar, expand/collapse) expected by area_maintenance.
*
* This function is aliased to both update_data_version.prototype.list and
* update_data_version.prototype.edit via the prototype assignments in
* update_data_version.js.
*
* @param {Object} options - Render options supplied by the widget lifecycle.
* @param {string} [options.render_level="full"] - 'full' returns the wrapper;
*   'content' returns only the inner content_data element.
* @param {string} [options.render_mode="list"] - Unused at this level; kept
*   for parity with the standard widget options contract.
* @returns {Promise<HTMLElement>} The widget wrapper (render_level 'full') or
*   the raw content_data element (render_level 'content').
*/
render_update_data_version.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
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
* GET_CONTENT_DATA
* Builds the complete inner content DOM for the update_data_version widget.
*
* This function handles two distinct states based on the server-supplied value:
*
* State A — no pending update (`update_version` is falsy):
*   Renders a green success message confirming the data version is current,
*   plus a 'Quit' button that signs the current user out of Dédalo via login.quit.
*
* State B — update required (`update_version` is truthy):
*   1. Styles the widget card label red ('danger') via set_widget_label_style.
*   2. Renders an info banner showing the current → target version transition
*      (e.g. "5.8.2 ---> 6.0.0").
*   3. Iterates `updates` and renders each step type:
*        - `alert_update`       — <h2> alert banners; may contain <code> blocks.
*        - `SQL_update`         — Checkbox-gated SQL statement entries.
*        - `components_update`  — Checkbox-gated component tipo entries.
*        - `run_scripts`        — Checkbox-gated script path entries.
*      Each actionable item gets a checkbox (checked by default) whose state is
*      tracked in the local `updates_checked` map keyed as `<type>_<index>`.
*      Unchecked items receive the 'disable' CSS class on their container.
*   4. After DOM insertion, syntax-highlights all <code> elements inside the
*      widget using highlight.js with the PHP grammar (when_in_dom callback).
*   5. Builds a `body_response` container and attaches the submit form via
*      `self.caller?.init_form` — but only when:
*        - The current user is root (`page_globals.is_root === true`), AND
*        - Maintenance mode is active (`page_globals.maintenance_mode === true`), AND
*        - The update bundle is not locked (`updates.lock !== true`).
*      If either gate fails a warning div is shown instead.
*   6. Defines `update_data_version` (inner async function) that fires the
*      server migration via data_manager.request with a 1-hour timeout and
*      `background_running: true`, then passes the returned `{pid, pfile}` to
*      update_process_status for SSE-based live progress display.
*   7. Defines `check_process_data` and calls it immediately to re-attach to
*      any already-running migration detected in IndexedDB.
*
* The `updates_checked` map is captured by the on_submit closure; only keys with
* value `true` are sent to the server — the server skips steps whose keys are
* absent or false.
*
* @param {Object} self - The update_data_version widget instance.
* @param {Object} [self.value] - Payload from the server.
* @param {Array}  [self.value.update_version] - Target version array, e.g. [6,0,0].
*   Falsy when no update is pending.
* @param {Array}  [self.value.current_version_in_db] - Current stored version,
*   e.g. [5,8,2].
* @param {string} [self.value.dedalo_version] - Application version string
*   (declared on self.value but not currently rendered in the UI).
* @param {Object} [self.value.updates] - Step bundle keyed by type; see above.
* @param {boolean} [self.value.updates.lock] - When true, the form is suppressed.
* @returns {Promise<HTMLElement>} The constructed content_data <div> element.
*/
const get_content_data = async function(self) {

	// short vars
		const value					= self.value || {}
		const update_version		= value.update_version
		const current_version_in_db	= value.current_version_in_db || []
		const dedalo_version		= value.dedalo_version
		const updates				= value.updates
		const local_db_id			= 'process_update_data_version'

	// maintenance_mode from environment
		const maintenance_mode = page_globals.maintenance_mode

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// set widget container label color style
		if (update_version) {
			set_widget_label_style(self, 'danger', 'add', content_data)
		}

	// dedalo_db_management
		if (!update_version) {
			// Info text
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text success_text',
				text_content	: 'Data format is updated: ' + current_version_in_db.join('.'),
				parent			: content_data
			})
			// Button quit. Allows the user quit from Dédalo here
			const button_quit = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'quit_button light',
				inner_html		: 'Quit',
				parent			: content_data
			})
			const click_handler = (e) => {
				e.stopPropagation()
				login.quit({
					caller : self
				})
			}
			button_quit.addEventListener('click', click_handler)

			return content_data
		}

	// info
		const text = 'To update data version: ' + current_version_in_db.join('.') + ' ---> ' + update_version.join('.')
		const info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_text error_text',
			text_content	: text,
			parent			: content_data
		})

	// updates
		// Tracks per-step checkbox state: keys are '<type>_<index>', values are boolean.
		// This map is read by on_submit and forwarded to the server as options.updates_checked.
		const updates_checked = {}
		if (updates) {

			const updates_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'updates_container',
				parent			: content_data
			})

			for (const [key, current_value] of Object.entries(updates)) {
				// console.log(`${key}: `, current_value);
				// if (!Array.isArray(current_value)) {
				// 	continue; // skip non array elements
				// }

				const current_value_length = current_value.length

				switch (key) {
					case 'alert_update':
						for (let i = 0; i < current_value_length; i++) {
							const item = current_value[i]
							// alert_update_node
							ui.create_dom_element({
								element_type	: 'h2',
								class_name		: 'alert_update',
								// item.command is the legacy key; item.notification is the v7 key
								text_content	: String(item.command || item.notification || ''),
								parent			: content_data
							})
						}
						break;

					case 'SQL_update':
					case 'components_update':
					case 'run_scripts':
						for (let i = 0; i < current_value_length; i++) {

							const item = current_value[i]

							// key_name as 'components_update_1'
							const key_name = key + '_' + i

							// label as 'SQL_update', 'components_update', run_scripts'
								if (i===0) {
									ui.create_dom_element({
										element_type	: 'h6',
										class_name		: '',
										text_content	: String(key),
										parent			: content_data
									})
								}

							// command container
								const command_node = ui.create_dom_element({
									element_type	: 'div',
									class_name		: 'command',
									parent			: content_data
								})

							// key as 1
								ui.create_dom_element({
									element_type	: 'span',
									class_name		: 'vkey',
									text_content	: String(i+1),
									parent			: command_node
								})

							// checkbox
								const input_checkbox = ui.create_dom_element({
									element_type	: 'input',
									type			: 'checkbox',
									class_name		: 'checkbox_selector',
									parent			: command_node
								})
								input_checkbox.checked = true
								input_checkbox.addEventListener('change', function(e) {
									// Mirror the checkbox state into the tracking map.
									// The 'disable' class provides visual feedback without
									// removing the item from the DOM.
									updates_checked[key_name] = input_checkbox.checked
									if (!input_checkbox.checked) {
										// unchecked case
										command_node.classList.add('disable')
									}else{
										command_node.classList.remove('disable')
									}
								})

							// value as 'component_3d'
								const vkey_value_node = ui.create_dom_element({
									element_type	: 'span',
									class_name		: 'vkey_value',
									// Objects (e.g. components_update entries) are pretty-printed
									// as JSON; plain strings (SQL or script paths) are trimmed.
									text_content	: typeof item==='string' ? item.trim() : JSON.stringify(item, null, 2),
									parent			: command_node
								})

							// updates_checked set
								updates_checked[key_name] = input_checkbox.checked // true // default
						}
						break;
				}
			}//end or (const [key, current_value] of Object.entries(updates))

			// highlight code tags inside alert_update
			// Deferred until content_data is in the DOM so hljs can query real elements.
			when_in_dom(content_data, ()=>{
				content_data.querySelectorAll('code').forEach((el) => {
					hljs.highlightElement(el);
			  });
			})
		}

	// body_response
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// form init
		switch (true) {
			case (page_globals.is_root!==true):
				// message not allowed
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'warning',
					inner_html		: 'Only root user can do this action',
					parent			: body_response
				})
				break;
			case (maintenance_mode!==true):
				// not allowed yet — the reason AND the switch, in place
				render_maintenance_prereq(body_response, () => self.refresh())
				break;
			case (updates.lock === true):
				// When the server marks the bundle as locked (update already running),
				// the submit form is suppressed entirely — no button, no warning.
				break
			default:
				// create the submit button
				// self.caller is the parent area_maintenance instance; init_form is an
				// alias for render_area_maintenance::build_form wired in area_maintenance.js.
				self.caller?.init_form({
					submit_label	: self.name,
					confirm_text	: get_label.sure || 'Sure?',
					body_info		: content_data,
					body_response	: body_response,
					on_submit	: () => {

						// check empty selection
							// Guard: if every checkbox is unchecked, ask the user to confirm
							// before sending an effectively empty updates_checked payload.
							const empty_selection = Object.values(updates_checked).every((v) => v === false)
							if (empty_selection) {
								const msg = (get_label.empty_selection || 'Empty selection') + '. Continue?'
								if (!confirm( msg )) {
									return
								}
							}

						// update_data_version
							update_data_version()
							.then(function(response){
								// Hand the {pid, pfile} handle to the SSE poller so the
								// administrator gets a live progress view in body_response.
								update_process_status(
									local_db_id,
									response.pid,
									response.pfile,
									body_response
								)
							})
					}
				})
				break;
		}

	// update_data_version
		/**
		* UPDATE_DATA_VERSION (inner async function)
		* Fires the server-side migration as a background CLI process and
		* returns the {pid, pfile} handle needed to open the SSE progress stream.
		*
		* Sends `updates_checked` (the per-step boolean map built from the UI
		* checkboxes) to the server action `update_data_version` on
		* `dd_area_maintenance_api`.  The server validates superuser + maintenance_mode
		* again before delegating to `update::update_version($updates_checked)`.
		*
		* The request uses a 1-hour timeout to accommodate very large migrations;
		* `retries: 1` means no automatic retry on failure.
		*
		* @returns {Promise<Object>} API response object — on success contains
		*   at minimum `{ pid: string, pfile: string }` for SSE attachment.
		*/
		const update_data_version = async () => {
			if(SHOW_DEBUG===true) {
				console.log('))) updates_checked:', updates_checked);
			}

			// update_data_version process fire
			const response = await data_manager.request({
				body		: {
					dd_api			: 'dd_area_maintenance_api',
					action			: 'widget_request',
					prevent_lock	: true,
					source			: {
						type	: 'widget',
						model	: 'update_data_version',
						action : 'update_data_version'
					},
					options : {
						background_running	: true, // set run in background CLI
						updates_checked		: updates_checked
					}
				},
				retries : 1, // one try only
				timeout : 3600 * 1000 // 1 hour waiting response
			})

			return response
		}//end update_data_version

		/**
		* CHECK_PROCESS_DATA (inner function)
		* Reads the IndexedDB 'status' record for local_db_id and, if a live
		* {pid, pfile} handle is stored there, re-attaches the SSE progress
		* stream into body_response.
		*
		* This allows the widget to reconnect to a migration that was already
		* started in a previous session or after a page refresh without requiring
		* the user to re-submit the form.
		*
		* (!) Called immediately after definition — runs once on every mount.
		*
		* @returns {void}
		*/
		const check_process_data = () => {
			data_manager.get_local_db_data(
				local_db_id,
				'status'
			)
			.then(function(local_data){
				if (local_data && local_data.value) {
					update_process_status(
						local_db_id,
						local_data.value.pid,
						local_data.value.pfile,
						body_response
					)
				}
			})
		}
		check_process_data()

	// add at end body_response
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data



// @license-end
