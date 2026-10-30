// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* EXPORT_USER_PRESETS
* Persistence layer for named export configuration presets in tool_export.
*
* An export preset is a record in section dd1781 that captures the full state
* of the export tool UI (column selection, data format, breakdown mode, and
* option flags) so that users can restore it later without reconfiguring
* everything from scratch.  Each preset record stores:
*   - dd624  name label (component_input_text)
*   - dd625  config blob (component_json) — the serialised export config
*   - dd640  public flag (component_radio_button) — visible to all users
*   - dd641  default flag (component_radio_button) — auto-applied on open
*   - dd642  target section_tipo (component_input_text) — scopes the preset
*   - dd654  owner user locator (component_select) — dd128/<user_id>
*
* The section layout mirrors the search preset section (dd623) so that the
* same child-component and view infrastructure can be reused.
*
* Main exports (all consumed by render_tool_export.js and
* view_export_user_presets.js):
*   build_export_config       – snapshot the current tool UI state into an object
*   apply_export_preset       – restore the tool UI from a saved config blob
*   load_user_export_presets  – fetch the preset list for the tool's sidebar
*   edit_user_export_preset   – open a preset record in edit mode (modal)
*   load_export_preset        – read the raw config blob for a preset record
*   create_new_export_preset  – create a new dd1781 record from current state
*   save_export_preset        – overwrite the config blob of an existing record
*   delete_user_export_preset – delete a preset record from the database
*   presets_section_tipo      – exported constant 'dd1781' used by callers
*/



// import
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {get_instance} from '../../../core/common/js/instances.js'



// vars
	// presets_section_tipo. Export presets section (mirrors search dd623). Reuses dd623 child components.
	export const presets_section_tipo					= 'dd1781'
	// component_json_preset_tipo. Where the export config blob is stored (component_json)
	const presets_component_json_tipo					= 'dd625'
	// component_section_value_tipo. Where the target section_tipo is stored (component_input_text)
	const presets_component_section_value_tipo			= 'dd642'
	// component_user_value_tipo. Where the owning user_id is stored (component_select)
	const presets_component_user_id_value_tipo			= 'dd654'
	// presets_component_name_value_tipo. Where the preset name is stored
	const presets_component_name_value_tipo				= 'dd624'
	// presets_component_public_value_tipo. Where the preset public value is stored
	const presets_component_public_value_tipo			= 'dd640'
	// presets_component_default_value_tipo. Where the preset default value is stored
	const presets_component_default_value_tipo			= 'dd641'



/**
* STORAGE_GET
* localStorage read of a per-viewer convenience (a remembered selector). The
* accessor can throw (private window, blocked site data) or come back empty:
* both mean "nothing remembered", never a broken tool.
* @param {string} key
* @returns {string|null}
*/
export const storage_get = function(key) {
	try {
		return window.localStorage.getItem(key)
	} catch (error) {
		return null
	}
}//end storage_get



/**
* STORAGE_SET
* localStorage write of a per-viewer convenience; a refused write is ignored
* (the value just is not remembered).
* @param {string} key
* @param {string} value
* @returns {boolean} true when stored
*/
export const storage_set = function(key, value) {
	try {
		window.localStorage.setItem(key, value)
		return true
	} catch (error) {
		return false
	}
}//end storage_set



/**
* GET_TARGET_SECTION_TIPO
* Normalizes the tool's target_section_tipo (which can be an array) to the
* scalar string used as the preset scope (stored in dd642 and matched by the
* SQO filter in load_user_export_presets).  When the export tool targets
* multiple section types, only the first is used as the key.
* @param {Object} self - The tool_export instance
* @returns {string} The scalar section tipo, e.g. 'dd25'
*/
const get_target_section_tipo = function(self) {
	return Array.isArray(self.target_section_tipo)
		? self.target_section_tipo[0]
		: self.target_section_tipo
}//end get_target_section_tipo



/**
* BUILD_EXPORT_CONFIG
* Snapshots the tool's current UI state into a plain config object suitable
* for storing as the component_json (dd625) blob inside a preset record.
* This is the inverse of apply_export_preset: that function reads from the
* blob; this function writes to it.
*
* The returned object shape:
* {
*   ar_ddo_to_export   : Array   — ordered column/ddo descriptors
*   data_format        : string  — 'value' | 'grid_value' | 'dedalo_raw'
*   breakdown          : string  — 'default' | 'rows' | 'columns'
*   fill_the_gaps      : boolean — server fills spanning values (default true)
*   (per-column value_with_parents flags ride inside ar_ddo_to_export — WC-049)
*   show_tipo_in_label : boolean — column labels include the tipo identifier
* }
*
* Checkbox values are read directly from the DOM via the tool's node reference
* so that this function can be called at any point in the save flow without
* requiring the caller to gather the option states separately.
* @param {Object} self - The tool_export instance
* @returns {Object} config - The serialisable export configuration snapshot
*/
export const build_export_config = function(self) {

	const node = self.node || document

	// helper. read a checkbox state by class with a fallback
	const get_checked = (class_name, fallback) => {
		const el = node.querySelector('.' + class_name)
		return el ? el.checked : fallback
	}

	// note: per-column value_with_parents flags travel INSIDE ar_ddo_to_export
	// (WC-049 — the old global checkbox is gone)
	return {
		ar_ddo_to_export	: self.ar_ddo_to_export || [],
		data_format			: self.data_format || 'value',
		breakdown			: self.breakdown || 'default',
		fill_the_gaps		: get_checked('fill_the_gaps_check', true),
		show_tipo_in_label	: get_checked('show_tipo_in_label_check', false)
	}
}//end build_export_config



/**
* APPLY_EXPORT_PRESET
* Rebuilds the export tool UI from a saved config blob, then persists the
* restored state as the current working state (IndexedDB via update_local_db_data).
*
* Steps performed:
*  1. Clears the existing user_selection_list DOM nodes and resets ar_ddo_to_export.
*  2. Re-builds each column entry from config.ar_ddo_to_export via build_export_component.
*  3. Restores data_format and breakdown selects (whitelist-validated before applying).
*  4. Restores option checkboxes (fill_the_gaps, show_tipo_in_label).
*  5. Re-syncs the disabled states that depend on data_format.
*  6. Calls update_local_db_data to write the restored state to IndexedDB.
*  7. Sets self.user_preset_section_id and reveals the save button.
*
* Calling this function mutates self in place; the caller does not need to
* trigger a separate render cycle.
*
* @param {Object} options
* @param {Object} options.self        - The tool_export instance
* @param {Object} options.config      - Export config blob (from load_export_preset)
* @param {string|number} options.section_id - The preset's section_id (dd1781)
* @returns {Promise<boolean>} Resolves to true when the preset has been fully applied
*/
export const apply_export_preset = async function(options) {

	// options
		const self			= options.self
		const config		= options.config || {}
		const section_id	= options.section_id

		const node					= self.node || document
		const user_selection_list	= self.user_selection_list

	// clear current selection (DOM + state)
		if (user_selection_list) {
			while (user_selection_list.hasChildNodes()) {
				user_selection_list.removeChild(user_selection_list.lastChild)
			}
		}
		self.ar_ddo_to_export = []

	// rebuild selected columns (same path as the IndexedDB restore loop)
		const ar_ddo = Array.isArray(config.ar_ddo_to_export)
			? config.ar_ddo_to_export
			: []
		for (let i = 0; i < ar_ddo.length; i++) {
			const ddo					= ar_ddo[i]
			const export_component_node	= await self.build_export_component(ddo)
			if (user_selection_list) {
				user_selection_list.appendChild(export_component_node)
			}
			self.ar_ddo_to_export.push(ddo)
		}

	// phone up/down buttons follow the rebuilt order
		self.update_phone_reorder_state()

	// data_format
		if (config.data_format && ['value','grid_value','dedalo_raw'].includes(config.data_format)) {
			self.data_format = config.data_format
			storage_set('selected_data_format_export', config.data_format)
			const select_format = node.querySelector('.select_data_format_export')
			if (select_format) {
				select_format.value = config.data_format
			}
		}

	// breakdown
		if (config.breakdown && ['default','rows','columns'].includes(config.breakdown)) {
			self.breakdown = config.breakdown
			storage_set('selected_breakdown_export', config.breakdown)
			const select_breakdown = node.querySelector('.select_breakdown_export')
			if (select_breakdown) {
				select_breakdown.value = config.breakdown
			}
		}

	// option checkboxes (defaults match the render: fill_the_gaps on, others off)
		const set_checked = (class_name, value) => {
			const el = node.querySelector('.' + class_name)
			if (el && el.checked!==!!value) {
				el.checked = !!value
				// a programmatic set fires no event: dispatch it, so a listener
				// (show_tipo_in_label re-renders the preview page) sees the change
				el.dispatchEvent(new Event('change'))
			}
		}
		set_checked('fill_the_gaps_check', config.fill_the_gaps !== false)
		set_checked('show_tipo_in_label_check', config.show_tipo_in_label === true)
		// note: a legacy preset's global value_with_parents is IGNORED (WC-049 —
		// per-column flags ride each restored ddo instead)

	// re-sync disabled states (breakdown only on grid_value; the per-column
	// parents checkboxes are disabled in dedalo_raw — a preset may carry
	// value_with_parents flags with the raw format selected)
		const select_breakdown = node.querySelector('.select_breakdown_export')
		if (select_breakdown) {
			select_breakdown.disabled = (self.data_format!=='grid_value')
		}
		if (typeof self.update_parents_checks_state==='function') {
			self.update_parents_checks_state()
		}
		if (typeof self.update_lang_state==='function') {
			self.update_lang_state()
		}

	// persist the applied preset as the current working state
		await self.update_local_db_data()

	// mark the selected preset and reveal the save button
		self.user_preset_section_id = section_id
		if (self.button_save_preset) {
			self.button_save_preset.classList.remove('hide')
		}

	return true
}//end apply_export_preset



/**
* LOAD_USER_EXPORT_PRESETS
* Fetches the list of saved export presets for the current user and target
* section_tipo, and returns a fully built section instance rendered with the
* 'export_user_presets' view (list mode, limited to 15 records).
*
* The SQO filter includes only records that satisfy BOTH:
*   (A) section_tipo stored in dd642 equals the tool's target_section_tipo
*   (B) at least one of:
*         - the preset is public (dd640 value matches the dd64 'public' locator)
*         - the preset belongs to the current user (dd654 value = dd128/<user_id>)
*
* The returned section instance has inspector and filter disabled to avoid
* rendering toolbar elements that are out of place in the preset sidebar.
* The 'export_user_presets' view (view_export_user_presets.js) is responsible
* for rendering each row with load / edit / delete action buttons.
*
* @param {Object} self - The tool_export instance
* @returns {Promise<Object>} The built section instance containing the preset list
*/
export const load_user_export_presets = async function(self) {

	// target_section_tipo. preset scope
		const target_section_tipo = get_target_section_tipo(self)

	// sqo
		const locator_user = {
			section_id		: '' + page_globals.user_id,
			section_tipo	: 'dd128'
		}
		const locator_public_true = {
			section_id			: '1',
			section_tipo		: 'dd64',
			from_component_tipo	: presets_component_public_value_tipo // 'dd640'
		}
		const filter = {
			"$and": [
				{
					q		: target_section_tipo,
					path	: [{
						component_tipo	: presets_component_section_value_tipo, // 'dd642',
						section_tipo	: presets_section_tipo, // 'dd1781'
						model			: 'component_input_text',
						name			: 'Section tipo'
					}],
					type: 'jsonb'
				},
				{
					"$or": [
						{
							q		: locator_public_true,
							path	: [{
								component_tipo	: presets_component_public_value_tipo, // 'dd640',
								section_tipo	: presets_section_tipo, // 'dd1781'
								model			: 'component_radio_button',
								name			: 'Public'
							}],
							type: 'jsonb'
						},
						{
							q		: locator_user,
							path	: [{
								component_tipo	: presets_component_user_id_value_tipo, // 'dd654',
								section_tipo	: presets_section_tipo, // 'dd1781'
								model			: 'component_select',
								name			: 'User'
							}],
							type: 'jsonb'
						}
					]
				}
			]
		}
		const sqo = {
			select			: [],
			section_tipo	: [{
				tipo : presets_section_tipo // 'dd1781'
			}],
			filter			: filter,
			limit			: 15,
			offset			: 0
		}

	// request_config
		const request_config = [{
			sqo			: sqo,
			api_engine	: 'dedalo',
			type		: 'main',
			show 		: {
				ddo_map : [{
					tipo			: presets_component_name_value_tipo, // 'dd624',
					section_tipo	: presets_section_tipo, // 'dd1781',
					parent			: presets_section_tipo // 'dd1781'
				}]
			}
		}]

	// section
		const instance_options = {
			model			: 'section',
			tipo			: presets_section_tipo, // 'dd1781'
			section_tipo	: presets_section_tipo, // 'dd1781'
			section_id		: null,
			mode			: 'list',
			lang			: page_globals.dedalo_data_lang,
			request_config	: request_config,
			add_show		: true,
			id_variant		: target_section_tipo + '_export_user_presets',
			inspector		: false, // (!) disable elements
			filter			: false, // (!) disable elements
			session_save	: true, // Set as true to save the session and preserve counter coherence
			view			: 'export_user_presets',
			caller			: self
		}
		const section = await get_instance(instance_options)
		await section.build(true)


	return section
}//end load_user_export_presets



/**
* EDIT_USER_EXPORT_PRESET
* Builds a section instance for editing the metadata fields of an existing
* preset record: name (dd624), public flag (dd640), and default flag (dd641).
* The config blob (dd625) and the section/user fields are intentionally
* excluded from the ddo_map — those are managed programmatically, not via UI.
*
* The instance is built in 'edit' mode with session_save=false to prevent it
* from overwriting the tool's own session state.  The inspector and filter
* toolbar elements are disabled so that the modal only shows the three fields.
*
* In each ddo entry, properties.show_interface.tools is set to false to
* suppress per-field toolbar buttons inside the modal (applied client-side by
* section_record — the server strips client ddo properties). The name also sets
* button_add false: a preset has ONE name, so the field offers no second value.
*
* Called by render_tool_export.js immediately after create_new_export_preset
* so the user can set the preset name before the modal is shown.
*
* @param {Object} self           - The tool_export instance (used for lang)
* @param {string|number} section_id - The section_id of the dd1781 record to edit
* @returns {Promise<Object>} The built section instance ready to be rendered into the modal
*/
export const edit_user_export_preset = async function(self, section_id) {

	// request_config
		const request_config = [{
			api_engine	: 'dedalo',
			type		: 'main',
			show		: {
				ddo_map : [
					{
						tipo			: presets_component_name_value_tipo, // 'dd624',
						section_tipo	: presets_section_tipo, // 'dd1781'
						parent			: presets_section_tipo, // 'dd1781'
						// one name per preset: no 'add value' button
						properties : { show_interface : { tools : false, button_add : false } }
					},
					{
						tipo			: presets_component_public_value_tipo, // 'dd640',
						section_tipo	: presets_section_tipo, // 'dd1781'
						parent			: presets_section_tipo, // 'dd1781'
						properties : { show_interface : { tools : false } }
					},
					{
						tipo			: presets_component_default_value_tipo, // 'dd641',
						section_tipo	: presets_section_tipo, // 'dd1781'
						parent			: presets_section_tipo, // 'dd1781'
						properties : { show_interface : { tools : false } }
					}
				]
			}
		}]

	// section
		const instance_options = {
			model			: 'section',
			tipo			: presets_section_tipo, // 'dd1781'
			section_tipo	: presets_section_tipo, // 'dd1781'
			section_id		: section_id,
			mode			: 'edit',
			lang			: page_globals.dedalo_data_lang,
			request_config	: request_config,
			add_show		: true,
			session_save	: false, // Set as false to prevent overwrite of the current session
			id_variant		: presets_section_tipo +'_'+ section_id + '_export_user_preset_edit'
		}
		const section = await get_instance(instance_options)
		// filter search disallow
			section.filter = false
		// inspector disallow
			section.inspector = false
		// build
			await section.build(true)


	return section
}//end edit_user_export_preset



/**
* LOAD_EXPORT_PRESET
* Retrieves the serialised export configuration object for a specific preset
* record by loading the component_json instance (dd625) directly.
*
* component_json entries are stored as wrapper objects of the form
* { id, value } where `value` holds the actual payload.  This function unwraps
* that envelope if present, returning the flat config object expected by
* apply_export_preset.  An already-unwrapped entry (one whose top-level keys
* include 'ar_ddo_to_export') is returned as-is to maintain forward
* compatibility if the storage format changes.
*
* The component is loaded using the language-neutral 'lg-nolan' lang key
* (page_globals.dedalo_data_nolan) because the config blob is not
* language-specific.
*
* @param {Object} options
* @param {string} options.section_id - The section_id of the dd1781 preset record
* @returns {Promise<Object>} The unwrapped export config blob, or {} if none stored
*/
export const load_export_preset = async function(options) {

	// options
		const section_id = options.section_id

	// component
		const instance_options = {
			tipo			: presets_component_json_tipo, // dd625
			section_tipo	: presets_section_tipo, // dd1781
			section_id		: section_id,
			model			: 'component_json',
			mode			: 'edit',
			lang			: page_globals.dedalo_data_nolan
		}
		const component = await get_instance(instance_options)
		await component.build(true)
		const entries = component.data.entries

	// config blob
		// component_json entries are stored as wrapper objects {id, value}; the
		// actual config payload lives under .value. Unwrap it, but tolerate an
		// already-unwrapped entry (one that carries the payload directly).
		let config = (entries && entries[0])
			? entries[0]
			: {} // default empty config
		if (
			config && typeof config==='object' && !Array.isArray(config)
			&& !('ar_ddo_to_export' in config)
			&& config.value && typeof config.value==='object'
		) {
			config = config.value
		}


	return config
}//end load_export_preset



/**
* CREATE_NEW_EXPORT_PRESET
* Creates a new dd1781 record in the database and writes the three bootstrap
* component values in parallel: the target section_tipo (dd642), the owning
* user locator (dd654), and the current export config blob (dd625).
*
* Flow:
*  1. POST action='create' to get a new section_id from the API.
*  2. Fan out three independent save calls via Promise.all — each call
*     get_instances its own component, builds it, then saves a single-entry
*     insert action.  The three writes are independent and can safely run
*     concurrently.
*  3. Returns the new section_id so the caller can immediately open the
*     edit modal (edit_user_export_preset) for name/public/default entry.
*
* The name, public, and default fields are intentionally left blank here;
* the user fills them in via the modal opened by the caller.
*
* @param {Object} options
* @param {Object} options.self         - The tool_export instance
* @param {string} options.section_tipo - The presets section tipo (dd1781)
* @returns {Promise<string|boolean>} The new section_id string, or false on API error
*/
export const create_new_export_preset = async function(options) {

	// options
		const self			= options.self
		const section_tipo	= options.section_tipo // dd1781

	// short vars
		const locator_user	= {
			section_id		: '' + page_globals.user_id,
			section_tipo	: 'dd128'
		}
		const target_section_tipo	= get_target_section_tipo(self)
		const config				= build_export_config(self)

	// data_manager. create
		const rqo = {
			action	: 'create',
			source	: {
				section_tipo : section_tipo
			}
		}
		const api_response = await data_manager.request({
			body		: rqo,
			use_worker	: true
		})

		// envelope v2: `create` answers with the new section_id as the payload
		const new_section_id = response_data(api_response)
		if (!new_section_id || new_section_id <= 0) {
			console.error('Error on create new export preset section. api_response:', api_response);
			return false
		}

	// save the preset components in parallel
		const save_promises = []

		// save target section_tipo value (dd642)
		save_promises.push(
			(async () => {
				const component_instance_section_tipo = await get_instance({
					tipo			: presets_component_section_value_tipo, // 'dd642',
					model			: 'component_input_text',
					section_tipo	: section_tipo,
					section_id		: new_section_id,
					mode			: 'edit'
				})
				await component_instance_section_tipo.build(true)
				await component_instance_section_tipo.save([{
					action	: 'insert',
					id		: null,
					value	: { value: target_section_tipo }
				}])
			})()
		)

		// save user value (dd654)
		save_promises.push(
			(async () => {
				const component_instance_user = await get_instance({
					tipo			: presets_component_user_id_value_tipo, // 'dd654',
					model			: 'component_select',
					section_tipo	: section_tipo,
					section_id		: new_section_id,
					mode			: 'edit'
				})
				await component_instance_user.build(true)
				await component_instance_user.save([{
					action	: 'insert',
					id		: null,
					value	: locator_user
				}])
			})()
		)

		// save current export config blob (dd625)
		save_promises.push(
			(async () => {
				const component_instance_json = await get_instance({
					tipo			: presets_component_json_tipo, // 'dd625',
					model			: 'component_json',
					section_tipo	: section_tipo,
					section_id		: new_section_id,
					mode			: 'edit'
				})
				await component_instance_json.build(true)
				await component_instance_json.save([{
					action	: 'insert',
					id		: null,
					value	: config
				}])
			})()
		)

		await Promise.all(save_promises)


	return new_section_id
}//end create_new_export_preset



/**
* SAVE_EXPORT_PRESET
* Overwrites the config blob of an existing preset record with the tool's
* current UI state.  Uses the 'set_data' changed_data action, which replaces
* the entire component_json entries array in one API call.  This prevents
* duplicate entries that would accumulate if 'insert' were used repeatedly on
* a single-value component.
*
* The value is wrapped in an array of one item matching the component_json
* storage shape: [ { value: <config> } ].  This is the same envelope that
* load_export_preset knows how to unwrap.
*
* The save button that triggers this function is hidden again by the caller
* after a successful save (see render_tool_export.js button_save_preset handler).
*
* @param {Object} options
* @param {Object} options.self         - The tool_export instance
* @param {string} options.section_tipo - The presets section tipo (dd1781)
* @param {string} options.section_id   - The section_id of the record to update
* @returns {Promise<Object|boolean>} The raw API response object, or false on error
*/
export const save_export_preset = async function(options) {

	// options
		const self			= options.self
		const section_tipo	= options.section_tipo
		const section_id	= options.section_id

	// verify vars
		if (!section_tipo || !section_id) {
			console.error('Invalid section_tipo or section_id:', section_tipo, section_id);
			return false
		}

	// current config blob
		const config = build_export_config(self)

	// rqo. save (set_data replaces the entire entries array)
		const rqo = {
			action	: 'save',
			source	: {
				tipo			: presets_component_json_tipo,
				section_tipo	: section_tipo,
				section_id		: section_id,
				lang			: page_globals.dedalo_data_nolan,
				type			: 'component'
			},
			data	: {
				changed_data : [
					{
						action	: 'set_data',
						id		: null,
						value	: [ { value : config } ]
					}
				]
			}
		}

	// API request
		const api_response = await data_manager.request({
			body		: rqo,
			use_worker	: true
		})

	// error check
		if (request_failed(api_response) || !response_data(api_response)) {
			console.error(`Error on save export preset (${section_tipo} - ${section_id}). api_response:`, api_response);
			return false
		}

		// debug
		if(SHOW_DEBUG===true) {
			console.log('Export preset saved!', api_response);
		}


	return api_response
}//end save_export_preset



/**
* DELETE_USER_EXPORT_PRESET
* Deletes a dd1781 preset record from the database via an API 'delete' action
* targeting the section model.  All child component data is removed by the
* server cascade.
*
* Called from view_export_user_presets.js when the user clicks the delete
* button on a preset row.  The caller is responsible for refreshing the
* preset list after this resolves.
*
* Returns the raw API response on success (api_response.result is typically
* the deleted section_id or a truthy confirmation value).
*
* @param {string} section_id - The section_id of the dd1781 record to delete
* @returns {Promise<Object|boolean>} The API response, or false when section_id is falsy
*/
export const delete_user_export_preset = async function(section_id) {

	// check
		if (!section_id) {
			console.error('Invalid section_id:', section_id);
			return false
		}

	// rqo
		const rqo = {
			action	: 'delete',
			source	: {
				section_tipo	: presets_section_tipo, // 'dd1781'
				section_id		: section_id,
				model			: 'section'
			}
		}

	// API request
		const api_response = await data_manager.request({
			body		: rqo,
			use_worker	: true
		})


	return api_response
}//end delete_user_export_preset



// @license-end
