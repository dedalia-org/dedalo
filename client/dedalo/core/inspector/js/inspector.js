// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global */
/*eslint no-undef: "error"*/



// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {common} from '../../common/js/common.js'
	import {get_tld_from_tipo,get_section_id_from_tipo} from '../../common/js/utils/index.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'
	import {
		render_inspector,
		render_section_info,
		load_record_info,
		render_component_info,
		load_time_machine_list,
		load_component_history,
		load_activity_info,
		update_project_container_body,
		open_ontology_window
	} from './render_inspector.js'



/**
* INSPECTOR
* Side-panel UI instance that provides contextual metadata, component history,
* time-machine controls, and ontology navigation for the currently active section.
*
* One inspector is created per section (section_tipo keyed). It wires itself into
* the global event bus so it responds to component activation/deactivation, section
* renders, and save events without polling.
*
* Key properties set during init:
*   - `caller`                   — the section instance that owns this inspector
*   - `actived_component`        — the component currently focused by the user, or null
*   - `paginator_container`      — DOM node holding the section-id display + navigation
*   - `element_info_container`   — DOM node for component/section metadata panel
*   - `component_history_container` — DOM node for the per-component history list
*   - `selection_info_node`      — DOM node showing the selected element's label
*   - `tm_list`     — the record-history list, a dd15 `section` instance (set by render_inspector)
*   - `last_docu_type`           — last ontology target used (for window coherence)
*
* Lifecycle: init → build → render (delegated to render_inspector.prototype.edit)
*
* Main exports:
*   inspector          — constructor (prototype-based class)
*   get_ontology_url   — standalone helper to build ontology navigation URLs
*/
export const inspector = function() {

	return true
}//end inspector



/**
* COMMON FUNCTIONS
* Extend inspector with shared prototype methods from common / render modules.
* The edit/render/refresh/destroy surface is identical to other Dédalo UI elements;
* inspector adds only destroy override and the full init implementation below.
*/
// prototypes assign
	inspector.prototype.edit	= render_inspector.prototype.edit
	inspector.prototype.render	= common.prototype.render
	inspector.prototype.refresh	= common.prototype.refresh

	/**
	* DESTROY
	* Overrides common.destroy to clean up active component value update events
	* subscribed during render_component_info(). Without this cleanup the
	* event_manager would hold a dangling handler pointing at the destroyed instance.
	* @param {boolean} delete_self - whether to remove this instance from the registry
	* @param {boolean} delete_dependencies - whether to destroy child instances
	* @param {boolean} remove_dom - whether to remove the root DOM node
	* @returns {Promise<boolean>} result of common.prototype.destroy
	*/
	inspector.prototype.destroy	= async function(delete_self=true, delete_dependencies=false, remove_dom=false) {
		const self = this
		// clean up active component value update event if exists
		if (self.element_info_container?.update_value_event_token) {
			event_manager.unsubscribe(self.element_info_container.update_value_event_token)
			self.element_info_container.update_value_event_token = undefined
		}
		// stop watching the component Data box height (render_inspector build_component_panel)
		if (self.element_info_container?.data_resize_observer) {
			self.element_info_container.data_resize_observer.disconnect()
			self.element_info_container.data_resize_observer = undefined
		}
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}



/**
* INIT
* Bootstraps an inspector instance for the given section. Seeds all instance
* properties and registers the four event-bus subscriptions that drive live updates:
*
*   render_<section_id>       — re-renders section info when the section reloads
*   activate_component        — switches the info panel to the focused component
*   save                      — refreshes history + time-machine on any component save
*   deactivate_component      — reverts to section info when no component is focused
*   render_component_filter_* — captures the filter node rendered by the section
*
* The duplicated-init guard (`this.is_init`) is shared with common.init() pattern
* and will log a console error + optionally alert (SHOW_DEBUG) on re-entry.
*
* (!) `self.tm_list` on line 103 is a bare expression with no assignment;
* it appears to be a placeholder / dead statement rather than an intentional initialisation.
* The property is actually set later by render_inspector via load_time_machine_list.
*
* @param {Object} options - initialisation options
* @param {string} options.section_tipo - ontology tipo of the owning section (e.g. 'dd368')
* @param {Object} options.caller - the live section instance that owns this inspector
* @returns {Promise<boolean>} true on successful initialisation
*/
inspector.prototype.init = async function(options) {

	const self = this

	// safe init double control. To detect duplicated events cases
		if (typeof this.is_init!=='undefined') {
			console.error('Duplicated init for element:', this);
			if(SHOW_DEBUG===true) {
				alert('Duplicated init element');
			}
			return false
		}
		this.is_init = true

	// status update
		self.status = 'initializing'

	self.id								= 'inspector_' + options.section_tipo
	self.model							= 'inspector'
	self.section_tipo					= options.section_tipo
	self.mode							= 'edit'
	self.node							= null
	self.caller							= options.caller // section instance

	self.actived_component				= null

	self.events_tokens					= []
	self.ar_instances					= []

	// nodes
	self.paginator_container			= null
	self.element_info_container			= null
	self.component_history_container	= null

	self.last_docu_type = null

	// fix active tm_list
	self.tm_list

	// events

		// render_ section
			const render_handler = () => {
				// a section render (load, pagination, refresh) re-reads the record info
				self.record_info_cache = null
				dd_request_idle_callback(
					() => update_section_info(self)
				)
			}
			self.events_tokens.push(
				event_manager.subscribe('render_' + self.caller.id, render_handler)
			)

		// activate_component (when user focus it in DOM)
			const activate_component_handler = (actived_component) => {

				self.actived_component = actived_component
				// selection info. Display current selected component label as 'Description'
				self.selection_info_node.update_label(actived_component)
				// component_info. Render tipo, model, translatable, etc.
				render_component_info(self, actived_component)
				// component_history. Load component history changes list
				dd_request_idle_callback(
					() => load_component_history(self, self.actived_component)
				)
				// open ontology window if already open to preserve component selected coherence
				if(SHOW_DEVELOPER===true) {
					dd_request_idle_callback(
						async () => {
							if (window.docu_window && !window.docu_window.closed) {
								const tipo	= actived_component.tipo
								const url	= await get_ontology_url(tipo, self.last_docu_type)
								if (url) {
									open_ontology_window(
										self,
										url,
										self.last_docu_type,
										false // focus bool
									)
								}
							}
						}
					)
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('activate_component', activate_component_handler)
			)

		// save. When selected component is saved, update component_history, time_machine_list and activity_info
			const save_handler = (options) => {
				const instance = options.instance
				// the save moved the Modified stamp: the next section-info render re-reads it
				self.record_info_cache = null
				if (self.actived_component && self.actived_component.id===instance.id) {
					// component_history update changes list if saved is current selected.
					// The save moved the data, so the cached block must be re-read.
					dd_request_idle_callback(
						() => load_component_history(self, self.actived_component, { reload: true })
					)
				}
				// time_machine_list update info on every component save
				dd_request_idle_callback(
					() => load_time_machine_list(self, { reload: true })
				)

				// activity_info. render notification bubbles on every component save action
				load_activity_info(self, options)
			}
			self.events_tokens.push(
				event_manager.subscribe('save', save_handler)
			)

		// deactivate_component
			const deactivate_component_handler = (component) => {
				// a component of ANOTHER section (a modal: e.g. the Time Machine note
				// editor, rsc832) leaving focus must not reset this inspector — it
				// would clear and destroy the component history the note was opened from
				if (component?.section_tipo!==self.section_tipo) {
					return
				}
				// note that transition between activate a component after deactivate other
				// is not the desired scenario to update section info. Because this, we wait a while
				// and check if is active some component before fire update_section_info
				setTimeout(function(){
					if (!page_globals.component_active) {
						dd_request_idle_callback(
							() => update_section_info(self)
						)
					}
				}, 250)
			}
			self.events_tokens.push(
				event_manager.subscribe('deactivate_component', deactivate_component_handler)
			)

		// render_component_filter_ (published by render_edit_section_record)
			const render_component_filter_handler = async (filter_instance) => {
				// fix rendered node
				self.component_filter_node = await filter_instance.render()
				// update project_container_body if it is already defined (pagination cases)
				if (self.project_container_body) {
					update_project_container_body(self)
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('render_component_filter_' + self.section_tipo, render_component_filter_handler)
			)

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Fulfils the standard Dédalo lifecycle contract (init → build → render).
* The inspector has no async data to prefetch before rendering, so this method
* is intentionally a no-op that simply advances the status flag.
* @returns {Promise<boolean>} true always
*/
inspector.prototype.build = async function() {

	const self = this

	// status update
		self.status = 'building'

	// Noting to do here. Only for live cycle compatibility

	// status update
		self.status = 'built'

	return true
}//end build



/**
* UPDATE_SECTION_INFO
* Resets the inspector to show section-level metadata after the active component
* is cleared. Called both when the section re-renders and when the user deactivates
* (unfocuses) a component with no other component taking focus within 250 ms.
*
* Sequence:
*   1. Clears `self.actived_component` so subsequent events know no component is selected.
*   2. Renders section-level info in the element_info_container panel.
*   3. Schedules time-machine list and component-history (null ⟹ empty) refreshes via
*      dd_request_idle_callback so they do not block the current render cycle.
*   4. Updates the selection_info_node label to the section caller.
*
* @param {Object} self - the inspector instance
* @returns {void}
*/
const update_section_info = (self) => {

	// section is inspector caller
	const section = self.caller

	// reset actived_component
	self.actived_component = null

	// update section info
	render_section_info(self)

	// record info (created / modified / published) — its own request, after render
	dd_request_idle_callback(
		() => load_record_info(self)
	)

	// time_machine_list load info. The section re-rendered (pagination or a new
	// record): the record-scoped blocks must re-read.
	dd_request_idle_callback(
		() => load_time_machine_list(self, { reload: true })
	)

	// component_history remove content id exists
	dd_request_idle_callback(
		() => load_component_history(self, null)
	)

	// selection info. Display current selected component label as 'Description'
	self.selection_info_node.update_label(section)

	// section_id display is owned by the paginator (.placeholder_section_id,
	// rendered from self.caller.section_id on each paginator render); no manual
	// DOM sync needed here.
}//end update_section_info



/**
* GET_ONTOLOGY_URL
* Resolves the navigation URL for a given ontology term (tipo) according to the
* requested target mode. Used both when the user opens the ontology panel and when
* a component activation must silently update an already-open docu_window.
*
* Target modes:
*   'docu_link'           — canonical online docs at dedalo.dev/ontology/<tipo>
*   'local_ontology'      — fetches the term's locator via the API and builds a
*                           local Dédalo page URL; falls through to
*                           'local_ontology_search' if the locator is not found
*   'local_ontology_search' — local search page pre-filtered to the tipo
*   'master_ontology'     — master.dedalo.dev record for the TLD section of tipo
*
* (!) The 'local_ontology' case has no explicit break/return before the
* 'local_ontology_search' case; if ontology_info is null the switch falls through
* and returns the search URL instead. This is intentional fallback behaviour but
* relies on implicit fall-through — worth making explicit in a future refactor.
*
* @param {string} tipo - ontology tipo identifier (e.g. 'dd345')
* @param {string} target - one of 'docu_link' | 'local_ontology' | 'local_ontology_search' | 'master_ontology'
* @returns {Promise<string|boolean>} the resolved URL string, or false when target is unrecognised
*/
export const get_ontology_url = async function (tipo, target) {

	switch (target) {

		case 'docu_link':
			return `https://dedalo.dev/ontology/${tipo}?lang=${page_globals.dedalo_application_lang}`

		case 'local_ontology':
			// tipo → matrix ontology locator is a PURE derivation — the same one
			// the 'master_ontology' case below already computes locally:
			// section_tipo = tld+'0', section_id = the tipo's digit run. The old
			// data_manager.get_matrix_ontology_locator API round-trip is gone
			// (DEC-16 re-sync); a tipo with no digit run falls through to the
			// dd5 search URL exactly like the old endpoint's result:false did.
			const locator_section_tipo	= get_tld_from_tipo(tipo) + '0'; // as 'tch0'
			const locator_section_id	= get_section_id_from_tipo(tipo); // as '38'
			if (locator_section_tipo.length>1 && locator_section_id) {
				return `${DEDALO_CORE_URL}/page/?tipo=${locator_section_tipo}&section_id=${locator_section_id}&session_save=false&menu=false`
			}
		case 'local_ontology_search':
			return DEDALO_CORE_URL + `/page/?tipo=dd5&menu=false&search_tipos=${tipo}`

		case 'master_ontology':
			const section_tipo_base	= get_tld_from_tipo(tipo) + '0'; // as 'tch0'
			const section_id_base	= get_section_id_from_tipo(tipo); // as '38'
			return `https://master.dedalo.dev/dedalo/core/page/?tipo=${section_tipo_base}&section_id=${section_id_base}&session_save=false&menu=false`
	}


	return false
}//end get_ontology_url



/**
* GET_RAW_RECORD
* Fetches the raw database record for the current caller section via API.
* Builds the request, sends it, and returns the first result on success.
*
* @return {Promise<object|false>} The raw record data, or false on error
*/
inspector.prototype.get_raw_record = async function () {

	const self = this

	// rqo
	const rqo = self.get_raw_record_rqo()

	// api request
	const api_response = await data_manager.request({
		body : rqo
	})

	// debug
	if (SHOW_DEBUG) {
		console.log('----> tool register read_raw api_response:', api_response);
	}

	// error case
	const raw_data = response_data(api_response)
	if (request_failed(api_response) || !raw_data) {
		console.error('----> ERROR tool register read_raw api_response:', api_response);
		return false
	}

	// Get record from data
	const data = raw_data[0] || null;
	if (!data) {
		console.error('----> ERROR tool register read_raw empty data. api_response:', api_response);
		return false
	}

	return data
}//end get_raw_record



/**
* GET_RAW_RECORD_RQO
* Builds the request query object (RQO) used by get_raw_record().
* Configures a read_raw action filtered by the caller's section_tipo and section_id.
*
* The resulting RQO targets the standard Dédalo API 'read_raw' action with
* pretty_print enabled so the raw JSON panel in the inspector is human-readable.
* limit:1 is safe because the SQO is filtered to a single section locator.
*
* @returns {Object} the configured RQO with action, options, and sqo
*/
inspector.prototype.get_raw_record_rqo = function () {

	const self = this

	const sqo = {
		section_tipo: [self.caller.section_tipo],
		limit: 1,
		filter_by_locators:[{
			section_tipo	: self.caller.section_tipo,
			section_id		: self.caller.section_id
		}]
	}

	// read from Dédalo API
	const rqo = {
		action	: 'read_raw',
		options	: {
			type			: 'section',
			section_tipo	: self.caller.section_tipo,
			tipo			: self.caller.section_tipo,
			model			: self.caller.model
		},
		sqo		: sqo,
		pretty_print : true
	}


	return rqo
}//end get_raw_record_rqo



// @license-end
