// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {handle_api_error} from '../../../../common/js/error_dispatch.js'
	import {error_text} from '../../../../common/js/render_api_error.js'



/**
* RENDER_LOCK_COMPONENTS
* Client-side render module for the lock_components maintenance widget.
*
* The lock_components system tracks which user currently holds a focus lock on
* each component within a section record, preventing concurrent-edit conflicts
* in real-time collaborative sessions. The PHP side (class.lock_components.php)
* stores the active-lock registry in the matrix_notifications table (row id=1).
*
* This module provides the administrator-facing UI in area_maintenance that:
*   1. Displays all currently active focus locks (active users and their components),
*      fetched via dd_area_maintenance_api → lock_components_actions → get_active_users.
*   2. Allows an admin to force-unlock all component locks globally or for a single
*      user, calling lock_components_actions → force_unlock_all_components.
*
* self.value shape (set by class.lock_components_widget.php::get_value()):
*   {
*     active_users : Object|null  — initial get_active_users_full() response object,
*                                   or null when no locks are held at load time
*   }
*
* The active_users response object (and every refresh response) has the shape:
*   {
*     result          : boolean          — true when the registry row exists
*     msg             : string           — status description
*     ar_user_actions : Array<Object>    — list of enriched focus-lock entries:
*       [{
*         user_id         : number,   // numeric user ID
*         full_username   : string,   // display name
*         component_model : string,   // ontology model string, e.g. "component_input_text"
*         component_tipo  : string,   // ontology tipo of the locked component, e.g. "rsc27"
*         component_label : string,   // human-readable term for the component
*         section_tipo    : string,   // ontology tipo of the section, e.g. "rsc167"
*         section_id      : string,   // record id within the section
*         section_label   : string,   // human-readable term for the section
*         date            : string    // "YYYY-MM-DD HH:MM:SS" timestamp of the focus event
*       }, …]
*   }
*
* Main exports:
*   render_lock_components               — empty constructor (prototype carrier)
*   render_lock_components.prototype.list — async entry point aliased to both
*                                           lock_components.prototype.edit and .list
*/



/**
* RENDER_LOCK_COMPONENTS
* Empty constructor used solely as a prototype carrier for the list() render method.
* The real widget instance (lock_components) is always passed in as `self` so this
* constructor is never called directly with `new`.
*/
export const render_lock_components = function() {

	return true
}//end render_lock_components



/**
* LIST
* Creates the nodes of the current widget and returns either the full wrapper
* or just the inner content_data node, depending on render_level.
*
* Delegates all DOM construction to get_content_data_edit(). The returned wrapper
* is the standard widget shell produced by ui.widget.build_wrapper_edit(), with a
* `content_data` property pointing to the inner content node for later access.
*
* @param {Object} options - Render options supplied by the widget lifecycle
*   {
*     render_level : {string} — "full" (default) returns the complete wrapper;
*                               "content" returns only content_data without the shell
*     render_mode  : {string} — "list" (informational, not used internally here)
*   }
* @returns {Promise<HTMLElement>} wrapper or content_data depending on render_level
*/
render_lock_components.prototype.list = async function(options) {

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
* Builds the full widget body for the lock_components maintenance view.
*
* Constructs three sections:
*   1. "Active users" heading — static label.
*   2. info_node (<pre>) — populated by print_active_users() with one row per
*      active focus lock. If the initial self.value.active_users already contains
*      lock data (result=true), it is rendered immediately on load; otherwise the
*      area starts empty until the first Refresh call completes.
*   3. "Refresh" button — on click, queries dd_area_maintenance_api for the current
*      lock list and re-renders info_node. A spinner is prepended to info_node while
*      the request is in flight; the content_data element receives class "lock"
*      to disable pointer events during the request.
*      (!) The spinner is NOT removed after a successful refresh — only the "lock"
*      class is removed. The `// spinner.remove()` line is intentionally commented
*      out in the original code. Do not change this.
*   4. "Unlock all components" button — prompts for an optional user_id. Pressing
*      Cancel (user_id===null) aborts with no API call. On confirm, calls
*      force_unlock_all_components and displays the JSON result in info_node.
*
* prevent_lock:true is passed on both requests so the API layer does not attempt
* to acquire a component lock while processing the admin action itself.
*
* @param {Object} self - The lock_components widget instance; must expose self.value
* @returns {Promise<HTMLElement>} content_data - Root div containing the complete widget body
*/
const get_content_data_edit = async function(self) {

	// short vars
		const value			= self.value || {}
		const active_users	= value.active_users || null

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// version
		// Static heading label; server-side i18n is not used here because the
		// widget always renders in the admin area with English labels.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: '',
			inner_html		: `Active users`,
			parent			: content_data
		})

	// info_node
		// <pre> container that holds the rendered list of active focus locks.
		// Each entry is appended by print_active_users(); the node is fully cleared
		// before every re-render to avoid duplicate rows.
		const info_node = ui.create_dom_element({
			element_type	: 'pre',
			class_name		: 'info_node',
			parent			: content_data
		})
		// If the widget was loaded with pre-fetched lock data (active_users.result=true),
		// render it immediately so the admin sees the state before clicking Refresh.
		if (active_users?.result) {
			print_active_users(active_users)
		}

	// button_refresh
		const button_refresh = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_refresh',
			inner_html		: 'Refresh',
			parent			: content_data
		})
		button_refresh.addEventListener('click', fn_refresh)
		/**
		* FN_REFRESH
		* Click handler for the Refresh button.
		* Queries the API for the current active-lock list and re-renders info_node.
		* Adds the "lock" CSS class to content_data for the duration of the request
		* to block double-submissions. The spinner is prepended to info_node while
		* the response is pending.
		*
		* (!) The spinner element is not removed after a successful refresh response —
		* `spinner.remove()` is commented out. This appears to be a pre-existing omission.
		*
		* @param {Event} e - The DOM click event
		* @returns {Promise<void>}
		*/
		async function fn_refresh(e) {
			e.stopPropagation()

			// button_spinner
				button_refresh.classList.add('button_spinner')

			try {
				// request
					const api_response = await data_manager.request({
						use_worker	: true,
						body		: {
							dd_api			: 'dd_area_maintenance_api',
							action			: 'lock_components_actions',
							prevent_lock	: true,
							options			: {
								fn_action : 'get_active_users'
							}
						},
						retries : 1, // one try only
						timeout : 3600 * 1000 // 1 hour waiting response
					})

					if (response_data(api_response)) {
						print_active_users(api_response)
					}
			} finally {
					// spinner.remove()
					button_refresh.classList.remove('button_spinner')
			}
		}//end fn_refresh
		// force first load
		// Programmatically trigger Refresh so the lock list is populated immediately
		// when the widget mounts, without requiring a manual click.
		button_refresh.click()

		/**
		* PRINT_ACTIVE_USERS
		* Clears info_node and renders one row per active focus lock from api_response.
		*
		* Each row consists of a gear icon span followed by a <div> whose inner text
		* describes the lock in a human-readable sentence using the enriched fields
		* provided by lock_components::get_active_users_full() on the PHP side:
		*   "User {user_id} ({full_username}) is editing {component_model} {component_tipo}
		*    ({component_label}) of section {section_tipo}-{section_id} ({section_label})
		*    from {date}"
		*
		* Called after every successful Refresh response and on initial load (when
		* active_users?.result is true).
		*
		* @param {Object} api_response - Response from lock_components_actions(get_active_users)
		*   {
		*     result          : boolean
		*     ar_user_actions : Array<Object>  — enriched lock entries (see module header)
		*   }
		*/
		function print_active_users(api_response) {
			// clean container
			while (info_node.firstChild) {
				info_node.removeChild(info_node.firstChild);
			}
			const api_response_ar_user_actions_length = api_response.ar_user_actions.length
			for (let i = 0; i < api_response_ar_user_actions_length; i++) {

				const item = api_response.ar_user_actions[i]

				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'icon gear',
					parent			: info_node
				})
				const label = `User ${item.user_id} (${item.full_username}) is editing ${item.component_model} ${item.component_tipo} (${item.component_label})`
					+ ` of section ${item.section_tipo}-${item.section_id} (${item.section_label}) from ${item.date}`
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: '',
					text_content	: label,
					parent			: info_node
				})
			}
		}

	// button_force_unlock_all_components
		const button_force_unlock_all_components = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_force_unlock_all_components',
			inner_html		: 'Unlock all components',
			parent			: content_data
		})
		button_force_unlock_all_components.addEventListener('click', fn_unlock)
		/**
		* FN_UNLOCK
		* Click handler for the "Unlock all components" button.
		* Prompts the admin for an optional user_id. If the user presses Cancel
		* (prompt returns null), the action is aborted immediately with no API call.
		* An empty string is sent as null so the PHP side removes locks for all users.
		*
		* After a successful API call the JSON result (action, result, msg) is written
		* into info_node using textContent (not innerHTML) to prevent XSS from any
		* server-provided message strings.
		*
		* (!) Uses prompt() for user_id input. A null return from prompt() means the
		* user clicked Cancel; an empty string means the user confirmed with no value,
		* which is treated as "remove locks for all users" via `user_id || null`.
		*
		* @param {Event} e - The DOM click event
		* @returns {Promise<void>}
		*/
		async function fn_unlock(e) {
			e.stopPropagation()

			// prompt
				const user_id = prompt('User id optional');
				if (user_id===null) {
					// user cancel action case
					return
				}

			// button_spinner
				button_force_unlock_all_components.classList.add('button_spinner')

			try {
				// request
					const api_response = await data_manager.request({
						use_worker	: true,
						body		: {
							dd_api			: 'dd_area_maintenance_api',
							action			: 'lock_components_actions',
							prevent_lock	: true,
							options			: {
								fn_action	: 'force_unlock_all_components',
								user_id		: user_id || null
							}
						},
						retries : 1, // one try only
						timeout : 3600 * 1000 // 1 hour waiting response
					})

					// SEC-XSS-008: textContent prevents any HTML parsing of the widget's
					// sentence embedded inside the JSON string.
					info_node.textContent = JSON.stringify({
						action	: 'force_unlock_all_components',
						result	: response_data(api_response) ?? null,
						msg		: request_failed(api_response)
							? error_text(api_response.error)
							: (response_extension(api_response, 'msg') || null)
					}, null, 2)

					// ONE error model: policy + renderer decide the surface
					if (request_failed(api_response)) {
						console.error('lock_components force_unlock_all_components failed:', api_response)
						await handle_api_error(api_response.error, {wrapper: info_node.parentNode || info_node})
					}
			} finally {
					button_force_unlock_all_components.classList.remove('button_spinner')
			}
		}//end fn_unlock



	return content_data
}//end get_content_data_edit



// @license-end
