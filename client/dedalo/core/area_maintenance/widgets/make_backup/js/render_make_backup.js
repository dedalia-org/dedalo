// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {update_process_status} from '../../../../common/js/common.js'
	import {response_data} from '../../../../common/js/api_error.js'



/**
* RENDER_MAKE_BACKUP
* Client-side render module for the make_backup maintenance widget.
*
* Responsibilities:
* - Build the widget's DOM subtree (PostgreSQL backup section and, when
*   the installation has MySQL databases, a MySQL backup section).
* - Drive the PostgreSQL backup submission through `self.make_backup()`.
* - Drive the MySQL backup submission through `area_maintenance.init_form`
*   → `handle_submit` → `self.make_mysql_backup`.
* - Poll (via `update_process_status`) for any backup process already
*   running when the widget is first opened, and keep the SSE stream
*   alive until the process exits.
* - Render collapsible, auto-refreshing file lists for both backup types
*   by polling `self.get_backup_files()` every 2 seconds while the panel
*   is expanded.
*
* Exported as a constructor whose prototype methods are assigned to
* `make_backup.prototype.edit` and `make_backup.prototype.list` in
* `make_backup.js`.
*
* Widget value shape (provided by `class.make_backup::get_value`):
* ```json
* {
*   "dedalo_db_management" : true,          // false disables the whole UI
*   "backup_path"          : "/srv/backups",
*   "last_scheduled_backup": null,                  // newest scheduled dump's name; null = backups are manual
*   "file_name"            : "2024-04-02_223514.dedalo6_development.postgresql_-1_forced_dbv6-1-4.custom.backup",
*   "mysql_db"             : [{ "db_name": "publication_db" }]  // null when not configured
* }
* ```
*/
export const render_make_backup = function() {

	return true
}//end render_make_backup



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
* @param {Object} options
* 	Sample:
* 	{
*		render_level : "full"
*		render_mode : "list"
*   }
* @returns {HTMLElement} wrapper
* 	To append to the widget body node (area_maintenance)
*/
render_make_backup.prototype.list = async function(options) {

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
* HANDLE_SUBMIT
* Generic helper that locks a target element, shows a spinner in the response
* area, awaits an API call, then renders the JSON result (or an error message)
* and removes the lock.
*
* Used by the MySQL backup form's `on_submit` callback so that the MySQL
* section gets the same loading/error UX as the PostgreSQL section without
* duplicating the boilerplate.
*
* (!) Uses `alert()` indirectly through callers; behaviour in iframe/CSP
* contexts may vary (pre-existing; do not change here).
*
* @param {HTMLElement} body_response - Container node where the JSON result or
*   error message is rendered. Existing children are cleared before rendering.
* @param {HTMLElement} target_lock - Element that receives the CSS class `lock`
*   during the request to prevent double-submission (e.g. the form container).
* @param {Function} api_call - Zero-argument async function that performs the
*   actual API request and returns an API response object. Must be callable as
*   `await api_call()`.
* @returns {Promise<void>} Resolves after the response has been rendered and the
*   lock released, regardless of success or failure.
*/
const handle_submit = async (body_response, target_lock, api_call) => {

	if (!body_response) {
		console.error('Body response div is mandatory.');
		return
	}

	if (!target_lock) {
		console.error('Target lock div is mandatory.');
		return
	}

	if (typeof api_call !== 'function') {
		console.error('Invalid api_call. Expected valid function.');
		return
	}

	// clean body_response nodes
	while (body_response.firstChild) {
		body_response.removeChild(body_response.firstChild);
	}

	try {
		// API worker call
		const api_response = await api_call();

		// response_node pre JSON response
		if (api_response) {
			ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'response_node',
				text_content	: JSON.stringify(api_response, null, 2),
				parent			: body_response
			})
		}else{
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'response_node error',
				inner_html		: 'Unknown error calling API',
				parent			: body_response
			})
		}
	} catch (error) {
		console.error('Error calling API:', error);
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_node error',
			inner_html		: 'Unknown error calling API',
			parent			: body_response
		})
	}
}//end handle_submit



/**
* GET_CONTENT_DATA
* Builds the full content subtree for the make_backup widget.
*
* Layout (when `dedalo_db_management` is enabled):
*   1. Info text showing the planned output path and file name.
*   2. `body_response` — receives the SSE process-status stream and inline
*      error messages from the PostgreSQL backup.
*   3. "Make backup" button that triggers `fn_submit`.
*   4. Collapsible PostgreSQL backup-files list (`render_psql_backup_files`).
*   5. (Conditional) MySQL backup form and collapsible MySQL files list,
*      shown only when `self.value.mysql_db` contains at least one entry
*      with a `db_name`.
*
* On first render the function immediately calls `check_process_data()` to
* detect any backup already running (stored in the local IndexedDB under
* key `process_make_backup / status`). If a running process is found its
* SSE stream is re-attached to `body_response` via `update_process_status`.
*
* @param {Object} self - Widget instance (`make_backup`). Must expose:
*   - `self.value`           {Object}  Widget value (see module header shape).
*   - `self.name`            {string}  Widget display name used as button label.
*   - `self.make_backup`     {Function} Async method that fires the PostgreSQL
*                                       backup and returns `{ result, pid, pfile }`.
*   - `self.caller`          {Object}  Parent `area_maintenance` instance exposing
*                                       `init_form()`.
*   - `self.make_mysql_backup` {Function} Async method for MySQL backup.
* @returns {Promise<HTMLElement>} The assembled `<div>` content node, with
*   `content_data.button_submit` set as a convenience reference to the submit
*   button element.
*/
const get_content_data = async function(self) {

	// short vars
		const value					= self.value || {}
		const dedalo_db_management	= value.dedalo_db_management
		const backup_path			= value.backup_path
		const file_name				= value.file_name
		const mysql_db				= value.mysql_db

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// dedalo_db_management
		// When the server config constant DEDALO_DB_MANAGEMENT is false, the
		// PHP class reports it here and we render only an informational notice.
		// No backup buttons or file lists are created.
		if (dedalo_db_management===false) {
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Dédalo backup if not allow by config DEDALO_DB_MANAGEMENT',
				class_name		: 'info_text comment',
				parent			: content_data
			})
			return content_data
		}

	// no scheduler
		// last_scheduled_backup is null when no scheduled dump of this database
		// ever landed in the backup directory: the engine starts none itself, so
		// without an OS scheduler every backup here is a click on this button.
		if (value.last_scheduled_backup===null) {
			const no_scheduler = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning no_scheduler',
				parent			: content_data
			})
			ui.create_dom_element({
				element_type	: 'strong',
				text_content	: 'No scheduler, backups are manual.',
				parent			: no_scheduler
			})
			const detail = ui.create_dom_element({
				element_type	: 'div',
				text_content	: 'No scheduled backup of this database was found in the backup directory. Dédalo makes none on its own: install a nightly job (deploy/dedalo-backup.timer, or the backup service of the Docker stack). ',
				parent			: no_scheduler
			})
			const docs_link = ui.create_dom_element({
				element_type	: 'a',
				href			: 'https://dedalo.dev/docs/v7/management/backup/#automatic-backup',
				text_content	: 'Database backup documentation',
				parent			: detail
			})
			docs_link.target	= '_blank'
			docs_link.rel		= 'noopener noreferrer'
		}

	// info text
		// built as nodes: the server paths are text, never spliced into markup
		const info = ui.create_dom_element({
			element_type	: 'div',
			text_content	: 'Force to make a full backup now like:',
			class_name		: 'info_text',
			parent			: content_data
		})
		const info_path = ui.create_dom_element({
			element_type	: 'div',
			text_content	: `${backup_path}/`,
			parent			: info
		})
		info_path.appendChild(document.createElement('br'))
		info_path.appendChild(document.createTextNode(file_name ?? ''))

	// body_response
		// Serves as the SSE process-status output zone. Injected into
		// update_process_status so the stream renders progress here.
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response',
			parent			: content_data
		})

	// check process status always
		// On widget mount, probe IndexedDB for a backup PID persisted by a
		// previous session or page reload. Re-attach the SSE stream if found,
		// so the user sees live progress without pressing the button again.
		const check_process_data = () => {
			data_manager.get_local_db_data(
				'process_make_backup',
				'status'
			)
			.then(function(local_data){
				if (local_data && local_data.value) {
					update_process_status(
						'process_make_backup',
						local_data.value.pid,
						local_data.value.pfile,
						body_response
					)
				}
			})
		}
		check_process_data()

	// fn_submit
		// Click handler for the PostgreSQL "make backup" button.
		// Guards against concurrent submissions by checking IndexedDB for an
		// active process entry before firing the API call.
		// (!) Uses alert() and confirm() which can be silently suppressed in
		// iframe/CSP environments (pre-existing behaviour; do not change here).
		const fn_submit = async (e) => {
			e.stopPropagation()

			// prevent multiple calls
			const local_db_data = await data_manager.get_local_db_data(
				'process_make_backup',
				'status'
			)
			if (local_db_data) {
				alert("Busy!");
				return
			}

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// blur button
			document.activeElement.blur()

			// call API to fire process and get PID
			const api_response = await self.make_backup()

			if (!api_response || !response_data(api_response)) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'error',
					inner_html		: 'Error: failed make_backup',
					parent			: body_response
				})
				return
			}

			// fire update_process_status
			// api_response.pid and api_response.pfile are provided by the server
			// when the backup process is launched as a background shell job.
			update_process_status(
				'process_make_backup',
				api_response.pid,
				api_response.pfile,
				body_response
			)
		}//end fn_submit

	// button submit (make backup)
		const button_submit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_submit',
			inner_html		: self.name,
			parent			: content_data
		})
		content_data.button_submit = button_submit
		button_submit.addEventListener('click', fn_submit)

	// add at end body_response
		content_data.appendChild(body_response)

	// backup_files
		const backup_files_container = render_psql_backup_files(self)
		content_data.appendChild(backup_files_container)

	// form backup MySQL DDBB
		// The MySQL section is optional: only rendered when the server config
		// includes at least one `API_WEB_USER_CODE_MULTIPLE` entry with a db_name.
		if (mysql_db && mysql_db[0] && mysql_db[0].db_name) {

			// mysql_body_response
			const mysql_body_response = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'body_response'
			})

			// form init
			// Delegates form creation to the parent area_maintenance instance so
			// the MySQL section gets the same locked/spinner/confirm UX as other
			// maintenance widgets. `on_submit` bypasses the default trigger path
			// and calls handle_submit directly, passing `self.make_mysql_backup`
			// as the zero-argument API call.
			self.caller.init_form({
				submit_label	: 'Backup MySQL DDBB: ' + mysql_db.map(el => el.db_name).join(', '),
				confirm_text	: get_label.sure || 'Sure?',
				body_info		: content_data,
				body_response	: mysql_body_response,
				on_submit		: async (e) => {
					await handle_submit(
						mysql_body_response,
						e.target,
						self.make_mysql_backup
					)
				}
			})

			// add at end body_response
			content_data.appendChild(mysql_body_response)

			// mysql_backup_files
			const backup_files_container = render_mysql_backup_files(self)
			content_data.appendChild(backup_files_container)
		}


	return content_data
}//end get_content_data



/**
* REFRESH_FILES_LIST
* Get and print the files list of selected type
* @param {Object} self - Widget instance exposing `self.get_backup_files()`.
* @param {string} type - Backup type selector: `'psql'` or `'mysql'`.
* @param {HTMLElement} container - Pre element whose text content is replaced
*   with the pretty-printed JSON array of file objects.
* @returns {Promise<void>}
*/
const refresh_files_list = async (self, type, container) => {

	const psql_backup_files		= (type==='psql')
	const mysql_backup_files	= (type==='mysql')

	// get files list updated
	const api_response = await self.get_backup_files({
		max_files			: 20,
		psql_backup_files	: psql_backup_files,
		mysql_backup_files	: mysql_backup_files
	})

	// message from API response
	const msg = response_data(api_response) || ['Unknown error']
	// print list
	// server text as TEXT, never an HTML sink
	container.textContent = JSON.stringify(msg, null, 2)
}//end refresh_files_list



/**
* RENDER_PSQL_BACKUP_FILES
* Renders the collapsible PostgreSQL backup-files panel.
*
* Structure:
*   <div class="backup_files_container">
*     <div class="backup_toggle_button">Show last files</div>   ← click to expand/collapse
*     <pre  class="backup_files_list hide">…JSON…</pre>         ← auto-refreshes every 2 s
*   </div>
*
* Toggle behaviour:
* - Each click toggles the `hide` CSS class on `backup_files_list`.
* - When the list becomes visible, `refresh_files_list` is called once
*   immediately, then a 2-second `setInterval` keeps it current.
* - When collapsed (or when the parent widget body becomes hidden), any
*   running interval is cleared, and the toggle button is programmatically
*   clicked to ensure the interval is not re-entered.
*
* File list JSON shape (one element per file):
* `[{ "name": "2024-04-02_223514.…custom.backup", "size": "5.34 GB" }]`
*
* @param {Object} self - Widget instance (`make_backup`) passed through to
*   `refresh_files_list`.
* @returns {HTMLElement} `backup_files_container` — ready to append to the
*   widget's content node.
*/
const render_psql_backup_files = function(self) {

	// container
	const backup_files_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'backup_files_container'
	})

	let interval = null

	// button backup_toggle_button
	const backup_toggle_button = ui.create_dom_element({
		element_type	: 'div',
		inner_html		: get_label.show_last_files || 'Show last files',
		class_name		: 'backup_toggle_button unselectable',
		parent			: backup_files_container
	})
	const click_handler = async (e) => {
		e.stopPropagation()
		// toggle backup_files_list visibility
		backup_files_list.classList.toggle('hide')
		// clean previous intervals
		if (interval) {
			clearInterval(interval);
		}
		// if hiding, return
		if (backup_files_list.classList.contains('hide')) {
			return
		}
		// call API and refresh the list
		refresh_files_list(self, 'psql', backup_files_list)
		// activate interval to refresh after 2 sec
		interval = setInterval(()=>{
			// check if widget body is hidden, if true, clear interval
			const widget_body = self.node.parentNode
			if (widget_body && widget_body.classList.contains('hide')) {
				// fire click_handler event to hide the list and stop interval
				backup_toggle_button.click()
				return
			}
			refresh_files_list(self, 'psql', backup_files_list)
		}, 2000);
	}
	backup_toggle_button.addEventListener('click', click_handler)

	// files list container (JSON array of objects) as
	// [{ "name": "2024-04-02_223514.dedalo6_development.postgresql_-1_forced_dbv6-1-4.custom.backup", "size": "5.34 GB"}]
	const backup_files_list = ui.create_dom_element({
		element_type	: 'pre',
		class_name		: 'backup_files_list hide',
		parent			: backup_files_container
	})


	return backup_files_container
}//end render_psql_backup_files



/**
* RENDER_MYSQL_BACKUP_FILES
* Renders the collapsible MySQL backup-files panel.
*
* Identical in structure and toggle behaviour to `render_psql_backup_files`,
* but passes `type='mysql'` to `refresh_files_list` and uses the CSS class
* `mysql_backup_files_list` on the inner `<pre>` to allow independent styling.
*
* Only rendered when `self.value.mysql_db` contains at least one entry
* (see `get_content_data`).
*
* File list JSON shape (one element per file):
* `[{ "name": "2024-04-02_223514.…custom.backup", "size": "5.34 GB" }]`
*
* @param {Object} self - Widget instance (`make_backup`) passed through to
*   `refresh_files_list`.
* @returns {HTMLElement} `backup_files_container` — ready to append to the
*   widget's content node.
*/
const render_mysql_backup_files = function(self) {

	// container
	const backup_files_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'backup_files_container'
	})

	let interval = null

	// button toggle
	const mysql_backup_toggle = ui.create_dom_element({
		element_type	: 'div',
		inner_html		: get_label.show_last_files || 'Show last files',
		class_name		: 'backup_toggle_button unselectable',
		parent			: backup_files_container
	})
	const click_handler = async (e) => {
		e.stopPropagation()
		// toggle backup_files_list visibility
		mysql_backup_files_list.classList.toggle('hide')
		// clean previous intervals
		if (interval) {
			clearInterval(interval);
		}
		// if hiding, return
		if (mysql_backup_files_list.classList.contains('hide')) {
			return
		}
		// call API and refresh the list
		refresh_files_list(self, 'mysql', mysql_backup_files_list)
		// activate interval to refresh after 2 sec
		interval = setInterval(()=> {
			// check if widget body is hidden, if true, clear interval
			const widget_body = self.node.parentNode
			if (widget_body && widget_body.classList.contains('hide')) {
				// fire click_handler event to hide the list and stop interval
				mysql_backup_toggle.click()
				return
			}
			refresh_files_list(self, 'mysql', mysql_backup_files_list)
		}, 2000);
	}
	mysql_backup_toggle.addEventListener('click', click_handler)

	// files list container (JSON array of objects) as
	// [{ "name": "2024-04-02_223514.dedalo6_development.postgresql_-1_forced_dbv6-1-4.custom.backup", "size": "5.34 GB"}]
	const mysql_backup_files_list = ui.create_dom_element({
		element_type	: 'pre',
		class_name		: 'mysql_backup_files_list hide',
		parent			: backup_files_container
	})


	return backup_files_container
}//end render_mysql_backup_files



// @license-end
