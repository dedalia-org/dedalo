// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG, Promise, page_globals */
/*eslint no-undef: "error"*/



// imports
	import {data_manager} from '../../../common/js/data_manager.js'
	import {clone} from '../../../common/js/utils/index.js'
	import {common, get_columns_map} from '../../../common/js/common.js'
	import {view_default_autocomplete} from './view_default_autocomplete.js'
	import {
		render_column_component_info
	} from '../../../component_portal/js/render_edit_component_portal.js'



/**
* SERVICE_AUTOCOMPLETE
* Pop-up search-and-select service wired to relation components and portals.
*
* Responsibilities:
*   - Accepts a typed search string from the caller UI and dispatches it to an
*     underlying search engine (the Dédalo internal API, or an external service
*     reached THROUGH the engine — never from this browser).
*   - Builds and manages the Search Query Object (SQO) used for each request,
*     merging caller-supplied filters (filter_free), fixed ontology filters
*     (fixed_filter), and optional list-restriction filters (filter_by_list).
*   - Delegates all DOM rendering to view_default_autocomplete.
*   - Exposes keyboard navigation (ArrowDown/Up/Enter) for the result datalist.
*
* Consumers: component_portal, component_relation_parent, component_relation_children,
*   component_relation_related (formerly also the retired component_autocomplete /
*   component_autocomplete_hi).
*
* Lifecycle: init → build → render → [autocomplete_search …] → destroy
*
* Main exports:
*   service_autocomplete (constructor)
*/
export const service_autocomplete = function() {

	this.id				= null
	this.model			= null
	this.mode			= null
	this.lang			= null
	this.node			= null
	this.ar_instances	= null
	this.status			= null
	this.events_tokens	= []
	this.type			= null
	this.caller			= null
	this.search_cache	= new Map() // keyed by the user's typed query: a Map, never `{}` (q may be '__proto__')
	this.limit			= 30
}//end service_autocomplete



/**
* COMMON FUNCTIONS
* extend config functions from common
*/
// prototypes assign
	// life-cycle
	service_autocomplete.prototype._parent_destroy = common.prototype.destroy
	// others
	service_autocomplete.prototype.hide		= view_default_autocomplete.hide
	service_autocomplete.prototype.show		= view_default_autocomplete.show



/**
* INIT
* Mandatory initial life-cycle function. Sets the service basic properties and state.
*
* Seeds all instance properties from `options` so that downstream lifecycle methods
* (build, render, autocomplete_search) can rely on their existence. Registers the
* instance on `window.page_globals.service_autocomplete` for debug inspection.
*
* A duplicate-call guard (`is_init`) prevents accidental double-initialisation.
* When SHOW_DEBUG is true a browser alert is fired in addition to the console error,
* making the error visible during development sessions.
*
* @param {Object} options - Initialization options
* @param {Object} options.caller - The component instance that owns this service
* @param {string} [options.view='text'] - View mode for the autocomplete renderer
* @param {string} [options.children_view] - View mode forwarded to child instances
* @param {Object} [options.properties={}] - Component properties sourced from the ontology
* @param {string} options.tipo - Structure tipo (ontology ID) of the host component
* @param {string} options.section_tipo - Section tipo that contains the host component
* @param {Array} options.request_config - Array of request-config objects (cloned internally)
* @param {string} [options.lang] - Language code; falls back to page_globals.dedalo_data_lang then 'lg-eng'
* @param {string} [options.id_variant] - Custom variant ID; defaults to 'service_autocomplete'
* @returns {Promise<boolean>} Resolves to true on success, false if already initialised
*/
service_autocomplete.prototype.init = async function(options) {

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

	// options
		self.caller			= options.caller
		self.view			= options.view || 'text'
		self.children_view	= options.children_view || null
		self.properties		= options.properties || {}
		self.tipo			= options.tipo
		self.section_tipo	= options.section_tipo
		self.request_config	= clone(options.request_config)
		self.lang			= options.lang || (typeof page_globals!=='undefined' ? page_globals.dedalo_data_lang : 'lg-eng')

	// id_base. Used for localStorage keys (filter state persistence)
	self.id_base = self.section_tipo + '_' + self.tipo

	// set properties
		self.model			= 'service_autocomplete'
		self.mode			= 'search'
		self.id_variant		= options.id_variant || self.model
		self.context		= {
			tipo			: self.tipo,
			section_tipo	: self.section_tipo,
			model			: self.model,
			lang			: self.lang,
			view			: self.view,
			children_view	: self.children_view,
			request_config	: self.request_config,
			mode			: self.mode,
			type			: 'autocomplete'
		}
		self.filter_free_nodes = []

	// DOM and instances
		self.node			= null
		self.ar_instances	= []

	// Set service instance as global (for debug only)
		window.page_globals.service_autocomplete = self

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Main build life-cycle function. Prepares the service search configurations,
* filters, operators, and columns mapping based on request_config.
*
* Implements a concurrency guard: if a build is already in progress the same
* Promise (`_build_waiter`) is returned so callers can safely await it without
* triggering a second build. If already built, returns true immediately.
*
* Key decisions made here:
*   - Locates the 'main' dedalo request_config entry that drives all searches.
*   - Resolves the boolean operator ($and/$or) from the config: search.sqo_config
*     takes priority over show.sqo_config; falls back to '$or' (a typed term must
*     match ANY searched component — with '$and' a multi-component SQO asks the
*     term to be in every component at once and returns nothing).
*   - Calls caller.build_rqo_search() to get the base SQO, ensuring project/language
*     scope matches the host component.
*   - Builds columns_map from the 'choose'→'search'→'show' ddo_map cascade.
*   - Registers a render callback for the optional 'ddinfo' info-panel column.
*   - Reads the persisted result limit from localStorage ('service_autocomplete_limit').
*
* (!) To force the operator, edit the request_config adding "sqo_config"
*     to "show" or "search":
*     {
*       "show": {
*         "sqo_config": { "operator": "$and" },
*         "ddo_map": [...]
*       }
*     }
*
* @param {Object} [options={}] - Build options
* @param {Object} [options.request_config_object] - Force a specific request-config entry,
*   bypassing the automatic lookup for type==='main' && api_engine==='dedalo'
* @returns {Promise<boolean>} Resolves to true on success, false when the required
*   request_config_object or rqo_search cannot be determined
*/
service_autocomplete.prototype.build = async function(options={}) {

	const self = this

	// check status to prevent concurrent builds
	switch (self.status) {
		case 'building':
			return self._build_waiter;
		case 'built':
			return true;
	}

	self.status = 'building'
	self._build_waiter = (async () => {

		// options vars
		self.request_config_object = (options.request_config_object)
			? options.request_config_object
			: self.request_config.find(el => el.api_engine === 'dedalo' && el.type === 'main')

		if (!self.request_config_object) {
			console.error('Error: Unable to find main dedalo request_config_object', self.request_config);
			self.status = 'initialized' // Reset status
			return false
		}

		// reset search options
		self.sqo				= {}
		self.ar_filter_by_list	= []
		self.ar_instances		= []
		self.list_name			= 's_' + Date.now()
		self.search_fired		= false

		// operator.
		// Default is '$or': the typed term is matched across ALL searched components.
		// With '$and' the same term would have to be present in every component at
		// once (e.g. numisdata60 AND the rest), which returns nothing in practice.
		// (!) To force the operator, edit the request_config adding "sqo_config" to "search" or "show":
		// {
		// 	"show": {
		// 		"sqo_config": {
		// 			"operator": "$and"
		// 		},
		// 		"ddo_map": [...]
		// 	}
		// }
		self.operator = self.request_config_object.search && self.request_config_object.search.sqo_config && self.request_config_object.search.sqo_config.operator
			? self.request_config_object.search.sqo_config.operator
			: self.request_config_object.show && self.request_config_object.show.sqo_config && self.request_config_object.show.sqo_config.operator
				? self.request_config_object.show.sqo_config.operator
				: '$or'

		// engine. get the search_engine sent or set the default value
		self.search_engine = self.request_config_object.api_engine || 'dedalo'

		// rqo_search, it's necessary do it by caller, because rqo is dependent of the source.
		// API get rqo to do the search as the caller.
		const rqo_search = await self.caller.build_rqo_search(self.request_config_object, 'search')
		if (!rqo_search || !rqo_search.sqo) {
			console.error('Error: Unable to build rqo_search from caller', self.caller);
			self.status = 'initialized'
			return false
		}
		self.rqo_search = rqo_search

		// set the section_tipo to be searched
		self.ar_search_section_tipo = self.rqo_search.sqo.section_tipo

		// columns_map
		// use the rqo_search as request_config, and the columns of rqo_search as columns_maps
		self.columns_map = get_columns_map({
			context				: self.context,
			ddo_map_sequence	: ['choose', 'search', 'show'] // array ddo_map_source
		}) || []

		// column component_info
		// the columns_map could contain more than one ddinfo column (one for each column
		// having ddo with value_with_parents=true). Every ddinfo column callback injects
		// its own `from_ddo_tipos` to render only the parents info generated by its anchor ddos.
		// @see common.js get_columns_map
		const ar_ddinfo_columns = self.columns_map.filter(el => el.id === 'ddinfo')
		const ar_ddinfo_columns_length = ar_ddinfo_columns.length
		for (let i = 0; i < ar_ddinfo_columns_length; i++) {
			const ddinfo_column = ar_ddinfo_columns[i]
			ddinfo_column.callback = function(options) {
				options.from_ddo_tipos = ddinfo_column.from_ddo_tipos || null
				return render_column_component_info(options)
			}
		}

		// limit. Get from localStorage if exists
		const service_autocomplete_limit = localStorage.getItem('service_autocomplete_limit')
		if (service_autocomplete_limit) {
			const limit = parseInt(service_autocomplete_limit)
			if (limit > 0) {
				self.limit = limit
			}
		}

		// status update
		self.status = 'built'

		return true
	})()

	return self._build_waiter
}//end build



/**
* DESTROY
* Tears down the service instance, removing DOM-level event listeners before
* delegating to the common base destructor.
*
* Removes the document-level 'keydown' listener that was registered to support
* keyboard navigation inside the datalist. Without this cleanup the handler
* would keep firing after the service is closed, leaking both memory and
* unintended keyboard side-effects.
*
* @param {boolean} [delete_self=true] - When true, delete self instance events,
*   paginator, services, inspector, filter and instance
* @param {boolean} [delete_dependencies=false] - When true, call destroy on all
*   associated child instances (ar_instances)
* @param {boolean} [remove_dom=false] - When true, remove the instance DOM node
* @returns {Promise<Object>} Result object from common.prototype.destroy:
*   { delete_dependencies: boolean, delete_self: boolean }
*/
service_autocomplete.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	// remove document keydown listener if stored
	if (self._fn_keydown) {
		document.removeEventListener('keydown', self._fn_keydown, false)
		self._fn_keydown = null
	}

	return self._parent_destroy(delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* SERVICE_AUTOCOMPLETE_KEYS
* Handles keyboard navigation (ArrowDown, ArrowUp, Enter) within the autocomplete datalist.
* This method is called from the keydown event listener when the component is active.
*
* Supports both modern key-name strings ('ArrowDown') and legacy numeric keyCodes (40)
* for broad browser compatibility.
*
* ArrowDown/ArrowUp move the '.selected' CSS class between sibling list items.
* Enter clicks the currently selected item, triggering its selection handler.
* All three keys call e.preventDefault() to prevent default browser behaviour
* (e.g. scrolling the page, submitting a form).
*
* @param {KeyboardEvent} e - The keyboard event object
* @returns {boolean} true when the event was handled; false when there is no datalist
*/
service_autocomplete.prototype.service_autocomplete_keys = function(e) {

	const self = this
	if (!self.datalist) {
		return false
	}

	// Stop event propagation to avoid conflicts with other UI elements
	e.stopPropagation()

	const key = e.key || e.which

	// down arrow
	if (key === 'ArrowDown' || key === 40) {
		e.preventDefault()

		const selected_node = self.datalist.querySelector('.selected')
		if (selected_node) {
			selected_node.classList.remove('selected')
			if (selected_node.nextElementSibling) {
				selected_node.nextElementSibling.classList.add('selected')
			}
		} else {
			// select the first one if nothing is selected
			const first_child = self.datalist.firstElementChild
			if (first_child) {
				first_child.classList.add('selected')
			}
		}
	}
	// up arrow
	else if (key === 'ArrowUp' || key === 38) {
		e.preventDefault()

		const selected_node = self.datalist.querySelector('.selected')
		if (selected_node) {
			selected_node.classList.remove('selected')
			if (selected_node.previousElementSibling) {
				selected_node.previousElementSibling.classList.add('selected')
			}
		}
	}
	// enter
	else if (key === 'Enter' || key === 13) {
		const selected_node = self.datalist.querySelector('.selected')
		if (selected_node) {
			e.preventDefault()
			selected_node.click()
		}
	}

	return true
}//end service_autocomplete_keys



/**
* RENDER
* Delegates the DOM generation to the view render module (view_default_autocomplete)
* based on the current service.view value.
*
* The view variable is captured locally to allow future per-view dispatch;
* all rendering logic currently lives in view_default_autocomplete.render.
*
* @param {Object} [options={}] - Render options forwarded to view_default_autocomplete
* @param {string} [options.render_level='full'] - Level of depth to render;
*   'full' builds wrapper + content, 'content' rebuilds inner content only
* @returns {Promise<HTMLElement>} The generated wrapper node (or content node on 'content' level)
*/
service_autocomplete.prototype.render = async function(options={}) {

	const self = this

	// view
		const view	= self.view

	// wrapper
		return view_default_autocomplete.render(self, options)
}//end render



/**
* AUTOCOMPLETE_SEARCH
* Orchestrates the autocomplete search process by calling the appropriate
* engine method (dedalo_engine, external_engine) defined by `self.search_engine`.
*
* The engine name is resolved dynamically: self.search_engine + '_engine' when
* this client implements one, otherwise external_engine for every non-dedalo
* api_engine (the ONE server action searches any bound service). If neither
* resolves, a console error is logged and an error result is returned without
* throwing.
*
* Guard: if no searchable section tipos are configured (ar_search_section_tipo is
* empty) the user is alerted via get_label.select_search_section and search is
* aborted. This prevents sending a malformed SQO to the API.
*
* (!) The alert() call here is intentional UX for misconfigured deployments where
*     the operator has not yet selected a search section from the UI.
*
* @returns {Promise<Object>} A promise resolving to the API response object:
*   { result: { data: Array } } on success, { result: false } on configuration error
*/
service_autocomplete.prototype.autocomplete_search = async function() {

	const self = this

	// debug
		if(SHOW_DEBUG===true) {
			// console.log('[service_autocomplete.autocomplete_search] search_engine:', self.search_engine)
			// console.log('self.request_config_object', self.request_config_object);
		}

	// engine name. A named engine wins when this client implements one
	// ('dedalo_engine', and the 'zenon_engine' alias kept for ontologies that
	// carry api_engine:'zenon'); ANY OTHER non-dedalo api_engine is an external
	// service, and the browser must not need to know which — the engine resolves
	// the service from the section's api_config. Before 2026-08-06 a second
	// service could not be added without editing this file.
		const named_engine	= self.search_engine + '_engine'
		const engine		= (typeof self[named_engine]==='function')
			? named_engine
			: (self.search_engine!=='dedalo' ? 'external_engine' : null)

	// check valid function name (defined in component properties search_engine)
		if (engine===null || typeof self[engine]!=='function') {
			console.error('ERROR. Received search_engine function not exists. Review your component properties source->request_config->search_engine :', self.search_engine);
			return {
				result: false
			}
		}

	// check valid filters_selector
		if ((self.ar_search_section_tipo?.length || 0)<1) {
			const label = get_label.select_search_section || 'Select a search section'
			alert(label);
			return {
				result: false
			}
		}

	// exec search self.search_engine = dedalo_engine || external_engine, the method that will called
		const js_promise = self[engine]()


	return js_promise
}//end autocomplete_search



/**
* REBUILD_SEARCH_QUERY_OBJECT
* Re-combines filter fields and section filters into a single search_query_object (SQO).
*
* Takes the base RQO built during build() and reconstructs its `sqo.filter` from
* three sources that are merged under a top-level $and:
*   1. filter_free  — per-field query terms entered by the user.  Each item's `q`
*      value is checked; empty items are skipped.  The operator ($and/$or) is
*      remapped to self.operator so the user can override the default.
*      If after filtering all items are empty, null is returned to signal "nothing
*      to search" (caller should skip the API call).
*   2. fixed_filter — static clauses injected from the ontology config; always
*      applied regardless of user input.
*   3. filter_by_list — optional list-restriction clauses (e.g. restricts search to
*      records already related to a given locator).  Wrapped in $or.
*
* Side-effects:
*   - Deletes rqo_search.sqo_options from the cloned RQO (server does not need it).
*   - Sets sqo.allow_sub_select_by_id = true to enable deep field matching.
*   - Sets sqo.limit from self.limit.
*   - Sets sqo.skip_projects_filter = true because autocomplete is read-only and
*     must not restrict the user to their project scope.
*
* (!) `rqo_search` is mutated in place. The caller (dedalo_engine) always passes
*     a fresh clone(self.rqo_search) so the canonical baseline is never corrupted.
*
* @param {Object} options - Configuration options
* @param {Object} options.rqo_search - The base Request Query Object (will be mutated)
* @param {Array} [options.search_sections=[]] - Section tipo IDs to search within;
*   returns null immediately if empty (no section selected)
* @param {Array|null} [options.filter_by_list=null] - Optional list of filter clauses
*   to restrict the result set to a pre-selected set of records
* @returns {Promise<Object|null>} The updated RQO ready to send to data_manager.request,
*   or null when filter_free resolves to empty (nothing to search)
*/
service_autocomplete.prototype.rebuild_search_query_object = async function(options) {

	const self = this

	// options
		const rqo_search		= options.rqo_search
		const search_sections	= options.search_sections || []
		const filter_by_list	= options.filter_by_list || null

	// no section selected case
		if(search_sections.length===0){
			return null
		}

		const sqo			= rqo_search.sqo
		const sqo_options	= rqo_search.sqo_options
		const fixed_filter	= sqo_options.fixed_filter //self.request_config_object.find((current_item)=> current_item.typo==='fixed_filter')
		const filter_free	= sqo_options.filter_free	//self.request_config_object.find((current_item)=> current_item.typo==='filter_free')

	// delete the sqo_options to the final rqo_options
		delete rqo_search.sqo_options

	// sqo filter
		sqo.filter = {
			$and : []
		}

		// rebuild the filter with the user inputs
			const filter_free_parse	= {}

			// Iterate current filter
			for (let operator in filter_free) {

				// set the operator with the user selection or the default operator defined in the config_sqo (it comes in the config_rqo)
				const new_operator = self.operator || operator
				// initialize once. When self.operator forces a single operator, several
				// source groups collapse onto the same key — do NOT reset it here or the
				// terms accumulated from a previous group would be lost.
				if (!filter_free_parse[new_operator]) {
					filter_free_parse[new_operator] = []
				}

				// get the array of the filters objects, they have the default operator
				const current_filter		= filter_free[operator]
				const current_filter_length	= current_filter.length
				for (let i = 0; i < current_filter_length; i++) {

					const filter_item = current_filter[i]

					const q = filter_item.q

					if(!q || q==='') {
						continue
					}

					filter_item.q = q
					filter_item.q_split = true

					// create the filter with the operator selected by the user
					filter_free_parse[new_operator].push(filter_item)
				}

			}

			// drop operator groups that ended up empty, and treat "everything empty"
			// as nothing-to-search (return null) — only after ALL groups are merged,
			// so a non-empty group is never discarded because another group is empty.
			for (const op of Object.keys(filter_free_parse)) {
				if (filter_free_parse[op].length === 0) {
					delete filter_free_parse[op]
				}
			}
			if (Object.keys(filter_free_parse).length === 0) {
				return null
			}

			sqo.filter.$and.push(filter_free_parse)

		// fixed_filter
			if (fixed_filter) {
				for (let i = 0; i < fixed_filter.length; i++) {
					sqo.filter.$and.push(fixed_filter[i])
				}
			}

			if(filter_by_list && filter_by_list.length > 0) {
				sqo.filter.$and.push({
					$or:[...filter_by_list]
					// $and:[...filter_by_list] // filter_by_list_inverse case
				})
			}

	// allow_sub_select_by_id set to false to allow select deep fields
		sqo.allow_sub_select_by_id = true

	// limit
		sqo.limit = self.limit

	// filter. Note that no project filter should be applied here. The user can
	// select any target record as read. Only editing has project restriction
		sqo.skip_projects_filter = true


	return rqo_search
}//end rebuild_search_query_object



/**
* DEDALO_ENGINE
* Executes a search against the Dédalo internal API using a fully constructed RQO.
*
* Flow:
*   1. Clones self.rqo_search to avoid mutating the canonical baseline.
*   2. Applies the current ar_search_section_tipo to sqo.section_tipo.
*   3. Evaluates filter_by_list optimisation: when the user has selected every
*      entry in the available datalist, the list filter is redundant and is dropped
*      (filter_by_list_fast = []) to produce a simpler, faster query.
*   4. Calls rebuild_search_query_object to compose the final SQO.
*   5. If rebuild_search_query_object returns null (empty filter_free), returns an
*      empty-data result immediately without hitting the network.
*   6. Sets source.mode = 'list' to enable language fallback for list views.
*   7. Sets source.config.read_only = true as a forward-compatibility hint for a
*      planned server-side autocomplete dispatcher. Note: the server currently does
*      NOT grant elevated read access based on this flag; users without direct read
*      permission on the target section will still be denied.
*   8. Issues the request through data_manager with use_worker = true (off main thread).
*
* An experimental filter_by_list_inverse block (commented out) explored inverting
* the list filter to exclude already-linked records. Left in place for future reference.
*
* @returns {Promise<Object>} A promise resolving to the API response from data_manager.request:
*   { result: { context: Array, data: Array }, msg: string }
*   or { result: { data: [] }, msg: 'Empty result' } when filter_free is empty
*/
service_autocomplete.prototype.dedalo_engine = async function() {

	const self = this

	// search_query_object base stored in wrapper dataset
		const rqo_search = clone(self.rqo_search)

		// const rqo_search		= clone(original_rqo_search)
		// self.rqo_search		= rqo_search
		// self.sqo				= rqo_search.sqo

	// search_sections. Mandatory. Always are defined, in a custom ul/li list or as default using wrapper dataset 'search_sections'
		const search_sections = self.ar_search_section_tipo

		rqo_search.sqo.section_tipo	= search_sections

	// filter_by_list, modify by user
		const filter_by_list = self.ar_filter_by_list.map(item => item.value)
		// filter_by_list optimized version.
		// A full selection of the list is equivalent to none. Remove useless list from search in these cases
		// (!) The selection must cover EVERY filter_by_list group, not just the first one.
		const filter_by_list_fast = is_full_list_selection(self.rqo_search.sqo_options?.filter_by_list, filter_by_list.length)
			? []
			: filter_by_list

		// filter_by_list_inverse (experimental)
			// const context = self.rqo_search.sqo_options.filter_by_list && self.rqo_search.sqo_options.filter_by_list[0]
			// 	? self.rqo_search.sqo_options.filter_by_list[0].context
			// 	: null
			// const component_tipo = context.tipo

			// const filter_by_list_inverse	= []
			// const datalist_length			= datalist.length
			// for (let i = 0; i < datalist_length; i++) {

			// 	const item	= datalist[i]

			// 	const q = '"' + component_tipo +'_'+ item.value.section_tipo +'_'+ item.value.section_id + '"'

			// 	const found = filter_by_list.find(el => {
			// 		return el.q ===  q
			// 	})
			// 	if (!found) {
			// 		const path = [{
			// 			section_tipo	: context.section_tipo,
			// 			component_tipo	: component_tipo
			// 		}]
			// 		filter_by_list_inverse.push({
			// 			q				: q, // partial locator: {from_component_tipo, section_tipo, section_id}
			// 			q_operator		: '!*',
			// 			path			: path,
			// 			format			: 'relation'
			// 		})
			// 	}
			// }

	// rqo
		const rqo = await self.rebuild_search_query_object({
			rqo_search		: rqo_search,
			search_sections	: search_sections,
			filter_by_list	: filter_by_list_fast
		})

	// empty filter_free values case. Nothing to search
		if(rqo===null){
			return {
				result : {
					data : []
				},
				msg	: 'Empty result'
			}
		}

	// const rqo = await options.rqo
		rqo.prevent_lock = true

	// source
		const source = rqo.source
		// make sure source is in list mode to allow lang fallback
		source.mode = 'list'
		// config. set config options like read_only to allow custom server behaviors
		// NOTE: server no longer trusts source.config.read_only as a permission shortcut
		// (was a privilege bypass). Users without direct read on the autocomplete target
		// section will now be denied. The flag is preserved here for forward-compat with
		// a future server-side autocomplete dispatcher that sets security::$read_only_scope.
		source.config = {
			...source.config,
			read_only : true
		}

	// API read request
		const load_section_data_promise	= data_manager.request({
			body		: rqo,
			use_worker	: true
		})

	// render section on load data
		const api_response = load_section_data_promise
		if(SHOW_DEBUG===true) {
			// api_response.then(function(response){
			// 	console.log('[service_autocomplete.dedalo_engine] api_response:', api_response);
			// })
		}

	return api_response
}//end dedalo_engine



/**
* SPLIT_Q
* Splits a search string on the pipe (|) character to support multi-field inputs.
*
* Used by callers that want to distribute sub-terms across separate search fields
* (e.g. "Picasso | 1937" to search name in one field and date in another).
* When no pipe is present the whole string is returned as a single-element array
* and divisor is false.
*
* The regex `/[^|]+/g` captures each pipe-delimited segment.  The zero-width-match
* guard (`regex.lastIndex++`) is standard boilerplate to prevent infinite loops
* when a zero-length match occurs.
*
* @param {string} q - The raw search string typed by the user
* @returns {Object} Result object:
*   { ar_q: Array<string>, divisor: string|boolean }
*   ar_q    — array of trimmed sub-terms
*   divisor — '|' if the input contained a pipe, false otherwise
*/
service_autocomplete.prototype.split_q = function(q) {

	const ar_q = []

	const regex = /[^|]+/g // /"[^"]+"|'[^']+'|[^|\s]+|[^\s|]+/ug;
	const str 	= q
	let m;

	while ((m = regex.exec(str)) !== null) {
		// This is necessary to avoid infinite loops with zero-width matches
		if (m.index === regex.lastIndex) {
			regex.lastIndex++;
		}

		// The result can be accessed through the `m`-variable.
		ar_q.push(m[0].trim())
	}

	const divisor = (q.indexOf('|')!==-1) ? '|' : false

	const result = {
		ar_q 	: ar_q,
		divisor : divisor
	}

	return result
}//end split_q



/**
* GET_FILTER_FREE_Q
* The terms the cataloguer typed, read from the SAME `filter_free` the dedalo
* engine reads: the search box is ONE box, whatever answers it.
*
* Returns the LAST non-empty `q` across every operator group — the behaviour
* the browser Zenon engine had, preserved byte-for-byte so pointing the widget
* at the server stays a swap of the transport and not a change of what is
* searched. (A multi-field autocomplete could send every group as separate
* terms — the engine accepts a `terms` array and the Zenon adapter joins it
* with a space — but that is a different query, and it belongs in its own
* change with its own gate.)
*
* @param {Object} self - The service_autocomplete instance
* @returns {string} the query, or '' when there is nothing to search
*/
const get_filter_free_q = function(self) {

	const filter_free = self.rqo_search && self.rqo_search.sqo_options
		? self.rqo_search.sqo_options.filter_free
		: null
	if (!filter_free) {
		return ''
	}

	let q = ''
	for (let operator in filter_free) {

		const current_filter		= filter_free[operator]
		const current_filter_length	= current_filter.length
		for (let i = 0; i < current_filter_length; i++) {

			const q_check = current_filter[i].q
			if (!q_check || q_check === '') {
				continue
			}
			q = q_check
		}
	}

	return q
}//end get_filter_free_q



/**
* EXTERNAL_ENGINE
* Search a third-party service THROUGH the Dédalo engine.
*
* Until 2026-08-06 this function WAS `zenon_engine`, and it issued a
* cross-origin XMLHttpRequest straight at the DAI Zenon search endpoint from the
* curator's browser (the origin is deliberately not repeated here — see the
* server module, src/external/search.ts). Everything about that was wrong:
*
*   - It went round every control the external subsystem has
*     (engineering/EXTERNAL_SPEC.md §5) — the kill switches, the operator's host
*     allowlist, the SSRF guard + socket pin, the circuit breaker, the
*     concurrency ceiling, the byte cap, the egress classification — because
*     none of them can see a request the server never makes.
*   - It could never work for an AUTHENTICATED service: a credential that
*     reaches a browser is a published credential.
*   - It stopped working outright when the app's CSP dropped third-party origins
*     from `connect-src` (XSS-02/RC-01), which is the symptom that surfaced it.
*     The fix is NOT to name the origin in `connect-src`: that value comes from
*     an operator-editable ontology field, so a cataloguer could aim the
*     directive at any host.
*   - It hard-coded ONE service's knowledge in the browser: the fallback URL,
*     a hard-coded German UI language, the remote field list, an authors-only
*     formatter and the
*     nonsense-string empty-query sentinel. All of it now lives in
*     `src/external/services/zenon.ts`, the ONE place that knows what Zenon is.
*
* What the browser now says is only: WHO is asking (the caller component's
* tipo + section_tipo) and WHAT was typed. The url, the host, the service name,
* the field list and the target section are all resolved server-side from the
* ontology (src/core/api/handlers/dd_external_api.ts). A client that could name
* the URL would be the browser-direct call again, wearing the engine's socket.
*
* The answer is the shape this function used to fabricate (`format_data`), built
* server-side now by `formatExternalSearchData`, so the rendering path below is
* untouched. Ledger: engineering/wire_contract/WC-2026-08-06-external-search-request.md.
*
* On failure the engine answers HTTP 200 with `result:false` and a
* `source_status` — the same typed provenance object the record path emits —
* which `render_search_notice` turns into a localized notice. The old code
* rejected with a generic network-error Error built at the XHR site, which the
* caller logged and swallowed: the curator saw an empty list and could not tell
* "the catalogue is down" from "this install has not allowlisted the host".
*
* @param {Object|null} options - Unused; kept so the engine signature is uniform
*   across dedalo_engine / external_engine.
* @returns {Promise<Object>} the API response:
*   { ok:true, data: { context: Array, data: Array } } on success,
*   { ok:false, error: ApiError, source_status?: Object } on failure,
*   { ok:true, data: { data: [] }, source_status: {state:'empty_query'} } when
*   nothing was typed (no request is made).
*/
service_autocomplete.prototype.external_engine = async function(options) {

	const self = this

	// q. Nothing else about the query leaves this browser.
		const q = get_filter_free_q(self)

	// empty query case. Refused HERE, without a round trip: the engine answers
	// an empty query with an empty result and no socket (src/external/search.ts),
	// so asking is pure latency. This is the one search state the client can
	// resolve by itself, and it is the one a curator most needs named — an empty
	// datalist otherwise reads as "the catalogue has nothing".
		if (q==='') {
			// The client's own envelope, in the SERVER's shape (envelope v2): the
			// caller reads it through response_data() like any other answer.
			return {
				ok		: true,
				data	: {
					data : []
				},
				source_status : {
					state		: 'empty_query',
					label_key	: 'external_search_empty_query',
					retryable	: false
				}
			}
		}

	// debug
		if(SHOW_DEBUG===true) {
			console.log('[external_engine] source:', self.section_tipo, self.tipo, 'q:', q);
		}

	// API search request. data_manager is the ONE request path of this client:
	// it carries the session cookie, the CSRF token and its rotation, the
	// re-login recovery on 401 and the error reporting. A hand-rolled
	// XMLHttpRequest bypasses all four.
		const api_response = await data_manager.request({
			// notices: this widget OWNS the degradation message. A down/blocked/
			// disabled source answers `ok:true` + `notices:[external.<kind>]` +
			// `source_status` (ERRORS_SPEC §5.4), and `render_search_notice` puts
			// the chip inside the datalist where the empty result is — the generic
			// page toast would say the same thing a second time, out of context.
			notices	: 'caller',
			body : {
				dd_api	: 'dd_external_api',
				action	: 'search',
				source	: {
					tipo			: self.tipo,
					section_tipo	: self.section_tipo
				},
				options	: {
					q		: q,
					limit	: self.limit
				}
			}
		})

	return api_response
}//end external_engine



/**
* ZENON_ENGINE
* Stable alias of external_engine.
*
* `autocomplete_search` resolves the engine by NAME (`api_engine` + '_engine'),
* and an ontology anywhere may carry `api_engine: 'zenon'`, so the name must
* keep resolving. It resolves to the service-agnostic engine: there is nothing
* Zenon-specific left in this client.
*/
service_autocomplete.prototype.zenon_engine = service_autocomplete.prototype.external_engine



/**
* GET_TOTAL
* Returns the current result limit as a surrogate for the total record count.
*
* Exists solely for compatibility with paginator components that expect every
* section-like service to expose a get_total() method. The returned value is
* self.limit (default 30, overridable via localStorage 'service_autocomplete_limit'),
* not the actual count of search results from the last query.
*
* (!) This is a stub — the autocomplete does not implement true pagination.
*     The returned number is the maximum page size, not the real result count.
*
* @returns {number} The configured result limit for this service instance
*/
service_autocomplete.prototype.get_total = function() {

	const self = this

	const total = self.limit

	return total
}//end get_total



/**
* IS_FULL_LIST_SELECTION
* Decide whether the user's filter_by_list selection covers the ENTIRE available
* list (across all groups), in which case the list filter is redundant and can be
* dropped for a simpler, faster query.
*
* (!) The total must sum the datalist length of every filter_by_list group; an
* earlier version compared only against the first group's length, which produced
* a wrong "full selection" verdict whenever more than one group was present.
*
* @param {Array} filter_by_list_groups - self.rqo_search.sqo_options.filter_by_list (or falsy)
* @param {number} selected_count - number of currently selected list values
* @returns {boolean} true when selected_count equals the total list size (>0)
*/
export const is_full_list_selection = function(filter_by_list_groups, selected_count) {

	const groups = Array.isArray(filter_by_list_groups) ? filter_by_list_groups : []

	let total = 0
	for (let i = 0; i < groups.length; i++) {
		const group_datalist = groups[i] && groups[i].datalist
		if (Array.isArray(group_datalist)) {
			total += group_datalist.length
		}
	}

	return total > 0 && selected_count === total
}//end is_full_list_selection



// @license-end
