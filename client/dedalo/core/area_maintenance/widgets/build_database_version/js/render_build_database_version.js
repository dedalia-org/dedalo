// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {update_process_status} from '../../../../common/js/common.js'
	import {data_manager} from '../../../../common/js/data_manager.js'



/**
* RENDER_BUILD_DATABASE_VERSION
* Client-side render module for the build_database_version area-maintenance widget.
*
* Responsibilities:
*   - Provides the `list` prototype method that widget_common dispatches for both
*     'edit' and 'list' render modes (both map to the same three-panel layout).
*   - Builds three operation panels, one per database lifecycle action:
*       1. build_install_version — clone + clean + export the live DB to a
*          distributable install image (.pgsql.gz).
*       2. build_recovery_version_file — export the live `dd_ontology` table to
*          the on-disk SQL snapshot `dd_ontology_recovery.sql`.
*       3. restore_dd_ontology_recovery_from_file — reimport the SQL snapshot to
*          recreate the `dd_ontology_recovery` table from a known-good state.
*
* Each panel shows a descriptive info line, a confirm-guarded action button, and
* an inline `process_response` div where the raw JSON API response is rendered
* once the (long-running) server call completes.
*
* The module is intentionally structured as a prototype-based constructor so it
* can be assigned to `render_build_database_version.prototype.list` and then
* re-assigned to `build_database_version.prototype.edit` and
* `build_database_version.prototype.list` in build_database_version.js.
*
* @exports {Function} render_build_database_version
*/



/**
* RENDER_BUILD_DATABASE_VERSION
* Constructor stub. No instance state is held here; all render logic lives in
* prototype methods and private module-scope functions.
* @returns {boolean} Always returns true (no-op constructor).
*/
export const render_build_database_version = function() {

	return true
}//end render_build_database_version



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
render_build_database_version.prototype.list = async function(options) {

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
* Assembles the top-level content_data container that holds all three operation
* panels. Each panel is wrapped in its own `group_container` div so the LESS
* stylesheet can style them independently.
*
* The `value` object received from the server (via get_value on the PHP side)
* has the shape: { source_db: string, target_db: string, target_file: string }.
* It is passed to sub-renderers so they can display the live DB names without
* an extra round-trip.
* @param {Object} self - Widget instance (build_database_version).
* @returns {Promise<HTMLElement>} content_data div containing all three panels.
*/
const get_content_data = async function(self) {

	// short vars
		const value = self.value || {}

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// build_install_version
		const build_install_version_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'group_container build_install_version_container',
			parent			: content_data
		})
		build_install_version_container.appendChild(
			render_build_install_version(self, value)
		)

	// build_recovery_version_file
		const build_recovery_version_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'group_container build_recovery_version_container',
			parent			: content_data
		})
		build_recovery_version_container.appendChild(
			render_build_recovery_version_file(self, value)
		)

	// restore_dd_ontology_recovery_from_file
		const restore_dd_ontology_recovery_from_file_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'group_container restore_dd_ontology_recovery_from_file_container',
			parent			: content_data
		})
		restore_dd_ontology_recovery_from_file_container.appendChild(
			render_restore_dd_ontology_recovery_from_file(self, value)
		)

	// build_matrix_hierarchy_main_sql
		const build_matrix_hierarchy_main_sql_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'group_container build_matrix_hierarchy_main_sql_container',
			parent			: content_data
		})
		build_matrix_hierarchy_main_sql_container.appendChild(
			render_build_matrix_hierarchy_main_sql(self, value)
		)


	return content_data
}//end get_content_data



/**
* RENDER_BUILD_INSTALL_VERSION
* Builds the DOM fragment for the "build install version" operation panel.
*
* The panel contains:
*   - An info line describing the clone source, target database, and output file
*     path (taken from the value object populated by the PHP get_value method).
*   - A button that, on click:
*       1. Requires user confirmation via `confirm()`.
*       2. Shows an in-progress message in `process_response`.
*       3. Disables the button (spinner class) while the long-running API call
*          is in flight (timeout: 1 hour, retries: 1).
*       4. Replaces `process_response` content with the raw JSON API response
*          once the call resolves.
*   - A `process_response` div for API output.
*
* On mount, `check_process_data` is called once to resume any previously started
* background process for this widget using the persistent key
* 'process_build_install_version' stored in IndexedDB via data_manager.
*
* Note: The commented-out `update_process_status` block below the click handler
* was the original background-polling implementation. It is superseded by the
* synchronous inline response but left in place for reference.
*
* @param {Object} self - Widget instance (build_database_version).
* @param {Object} value - Server-supplied value object:
*   { source_db: string, target_db: string, target_file: string }
* @returns {DocumentFragment} Fragment ready to be appended to the panel container.
*/
const render_build_install_version = function (self, value) {

	const source_db		= value.source_db
	const target_db		= value.target_db
	const target_file	= value.target_file

	const fragment = new DocumentFragment()

	// info
		const text = `Compiles the install database from the repository sources (${source_db}) in a scratch database (${target_db}), verifies it with a fresh install and writes it to: ${target_file}`
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: text,
			class_name		: 'info_text',
			parent			: fragment
		})

		// check process status always
		// On first render, check IndexedDB for a previously launched background
		// process. If one is found, resume the SSE poll via update_process_status.
		const check_process_data = () => {
			data_manager.get_local_db_data(
				'process_build_install_version',
				'status'
			)
			.then(function(local_data){
				if (local_data && local_data.value) {
					update_process_status(
						'build_install_version',
						local_data.value.pid,
						local_data.value.pfile,
						process_response
					)
				}
			})
		}
		check_process_data()

	// button_process build_install_version
		const button_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_process',
			inner_html		: self.name,
			parent			: fragment
		})
		// event click
		const click_handler = async (e) => {
			e.stopPropagation()

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			process_response.replaceChildren()
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text',
				inner_html		: 'Building.. please wait',
				parent			: process_response
			})

			// blur button
			document.activeElement.blur()

			// locks the button submit
			button_process.classList.add('button_spinner')

			try {
				// build_install_version
				const api_response = await self.build_install_version()

				// debug
				if (SHOW_DEBUG) {
					console.log('----> build_install_version api_response', api_response);
				}

				process_response.replaceChildren()
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: '',
					text_content	: JSON.stringify(api_response, null, 2),
					parent			: process_response
				})
			} finally {
				button_process.classList.remove('button_spinner')
			}

			// background process version
			// update_process_status(
			// 	'build_database_version',
			// 	api_response.pid,
			// 	api_response.pfile,
			// 	process_response
			// )
		}
		button_process.addEventListener('click', click_handler)

	// process_response
		const process_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_response',
			parent			: fragment
		})


	return fragment
}//end render_build_install_version



/**
* RENDER_BUILD_RECOVERY_VERSION_FILE
* Builds the DOM fragment for the "build recovery version file" operation panel.
*
* The panel triggers `self.build_recovery_version_file()`, which dispatches to
* the server via `dd_area_maintenance_api → widget_request` and exports the live
* `dd_ontology` table as `dd_ontology_recovery.sql` under `/install/db/`.
*
* The panel contains:
*   - An info line describing the file that will be generated.
*   - A confirm-guarded button that adds a `loading` CSS class while the call
*     is in flight and removes it on completion.
*   - A `process_response` div where the raw JSON API response is rendered.
*
* The response area is cleared with a `while (firstChild)` loop before printing
* the new result. This is equivalent to `replaceChildren()` but written for
* broader compatibility.
*
* (!) `self.build_recovery_version_file()` uses `use_worker: true` in its
* data_manager.request call, intended to keep the main thread unblocked. In
* the current codebase the worker path falls back to a normal fetch internally,
* so there is no functional difference.
*
* @param {Object} self - Widget instance (build_database_version).
* @param {Object} value - Server-supplied value object (not used in this panel).
* @returns {DocumentFragment} Fragment ready to be appended to the panel container.
*/
const render_build_recovery_version_file = function (self, value) {

	const fragment = new DocumentFragment()

	// info
		const text = `Creates 'dd_ontology_recovery.sql' file with basic Ontology data`
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: text,
			class_name		: 'info_text',
			parent			: fragment
		})

	// button_process build_recovery_version
		const button_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_process',
			inner_html		: 'Create \'dd_ontology_recovery.sql\' file',
			parent			: fragment
		})
		// event click
		const click_handler = async (e) => {
			e.stopPropagation()

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// blur button
			document.activeElement.blur()

			// locks the button submit
			button_process.classList.add('loading')
			button_process.classList.add('button_spinner')

			try {
				// build_recovery_version
				const api_response = await self.build_recovery_version_file()

				if(SHOW_DEBUG===true) {
					console.log('**** render_build_recovery_version_file api_response:', api_response);
				}

				// process_response print
				while (process_response.firstChild) {
					process_response.removeChild(process_response.firstChild);
				}
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'response',
					text_content	: JSON.stringify(api_response, null, 2),
					parent			: process_response
				})
			} finally {
				// unlocks the button submit
				button_process.classList.remove('loading')
				button_process.classList.remove('button_spinner')
			}
		}
		button_process.addEventListener('click', click_handler)

	// process_response
		const process_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_response',
			parent			: fragment
		})


	return fragment
}//end render_build_recovery_version_file



/**
* RENDER_RESTORE_DD_ONTOLOGY_RECOVERY_FROM_FILE
* Builds the DOM fragment for the "restore dd_ontology_recovery from file"
* operation panel.
*
* The panel triggers `self.restore_dd_ontology_recovery_from_file()`, which
* dispatches via `dd_area_maintenance_api → class_request` (not `widget_request`)
* and reimports `/install/db/dd_ontology_recovery.sql` to recreate the
* `dd_ontology_recovery` table in the live database.
*
* The panel contains:
*   - An info line describing the operation.
*   - A confirm-guarded button with the same `loading` toggle pattern used by
*     `render_build_recovery_version_file`.
*   - A `process_response` div where the raw JSON API response is rendered.
*
* Like the other panels, this operation dispatches via `widget_request` to
* `build_database_version::restore_dd_ontology_recovery_from_file`, gated by the
* widget-level `API_ACTIONS` list in `class.build_database_version.php`.
*
* (!) This handler calls `console.log` unconditionally (not guarded by
* `SHOW_DEBUG`). This differs from the pattern used in the other two panels.
*
* @param {Object} self - Widget instance (build_database_version).
* @param {Object} value - Server-supplied value object (not used in this panel).
* @returns {DocumentFragment} Fragment ready to be appended to the panel container.
*/
const render_restore_dd_ontology_recovery_from_file = function (self, value) {

	const fragment = new DocumentFragment()

	// info
		const text = `Restores table 'dd_ontology_recovery' from file`
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: text,
			class_name		: 'info_text',
			parent			: fragment
		})

	// button_process restore_dd_ontology_recovery_from_file
		const button_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_process',
			inner_html		: 'Restore \'dd_ontology_recovery\' table from file',
			parent			: fragment
		})
		// event click
		const click_handler = async (e) => {
			e.stopPropagation()

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// blur button
			document.activeElement.blur()

			// locks the button submit
			button_process.classList.add('loading')
			button_process.classList.add('button_spinner')

			try {
				// restore_dd_ontology_recovery_from_file
				const api_response = await self.restore_dd_ontology_recovery_from_file()

				console.log('**** render_restore_dd_ontology_recovery_from_file api_response:', api_response);

				// process_response print
				while (process_response.firstChild) {
					process_response.removeChild(process_response.firstChild);
				}
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'response',
					text_content	: JSON.stringify(api_response, null, 2),
					parent			: process_response
				})
			} finally {
				// unlocks the button submit
				button_process.classList.remove('loading')
				button_process.classList.remove('button_spinner')
			}
		}
		button_process.addEventListener('click', click_handler)

	// process_response
		const process_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_response',
			parent			: fragment
		})


	return fragment
}//end render_restore_dd_ontology_recovery_from_file



/**
* RENDER_BUILD_MATRIX_HIERARCHY_MAIN_SQL
* Creates the DOM nodes for the 're-create matrix_hierarchy_main.sql' action
* @param object self
* @param object value
* @return DocumentFragment
*/
const render_build_matrix_hierarchy_main_sql = function (self, value) {

	const fragment = new DocumentFragment()

	// info
		const text = `Retired (the engine refuses it): the thesaurus registry no longer ships as a SQL file. Optional thesauri are described by 'install/import/hierarchy/hierarchy.json' (Export hierarchy panel → Export hierarchy.json) and their registry rows are created from it at activation; the install seed carries only the core Languages row.`
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: text,
			class_name		: 'info_text',
			parent			: fragment
		})

	// button_process build_matrix_hierarchy_main_sql
		const button_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_process',
			inner_html		: 'Re-create \'matrix_hierarchy_main.sql\' file',
			parent			: fragment
		})
		// event click
		const click_handler = async (e) => {
			e.stopPropagation()

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// blur button
			document.activeElement.blur()

			// locks the button submit
			button_process.classList.add('loading')
			button_process.classList.add('button_spinner')

			try {
				// build_matrix_hierarchy_main_sql
				const api_response = await self.build_matrix_hierarchy_main_sql()

				if(SHOW_DEBUG===true) {
					console.log('**** render_build_matrix_hierarchy_main_sql api_response:', api_response);
				}

				// process_response print
				while (process_response.firstChild) {
					process_response.removeChild(process_response.firstChild);
				}
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'response',
					text_content	: JSON.stringify(api_response, null, 2),
					parent			: process_response
				})
			} finally {
				// unlocks the button submit
				button_process.classList.remove('loading')
				button_process.classList.remove('button_spinner')
			}
		}
		button_process.addEventListener('click', click_handler)

	// process_response
		const process_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_response',
			parent			: fragment
		})


	return fragment
}//end render_build_matrix_hierarchy_main_sql



// @license-end
