// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* MODULE search
* Core search controller for the Dédalo v7 search UI.
*
* This module exports the `search` constructor function that manages the
* in-browser search interface.  Each section or area that supports filtered
* navigation instantiates one `search` object.  The instance owns:
*
*  - A canonical in-memory filter model (`filter_model`) — a tree of group and
*    component nodes that is the single source of truth for the current filter
*    structure.  The DOM is a rendering of this model; structural mutations
*    always go through the model helpers (`create_group_model_node`,
*    `create_component_model_node`, `remove_model_node`, `move_model_node`),
*    not the DOM.
*
*  - The serialization path: `serialize_filter_model` walks the model tree to
*    produce the json_filter `{$and:[…]}` / `{$or:[…]}` object; this is then
*    wrapped by `parse_dom_to_json_filter` into a full `json_query_obj` and
*    passed to `update_caller` which writes back to the caller's `rqo.sqo` and
*    triggers navigation.
*
*  - Persistence of the filter as a "temp preset" (section dd655) in the server
*    database, so a user's in-progress filter survives page refreshes.
*    `build()` restores that preset on load; `update_state('changed')` saves it
*    after every edit.
*
*  - User-defined named presets (section dd623) managed by `search_user_presets.js`.
*
* Rendering is delegated to `render_search.js` (prototype assignments below).
* Drag-and-drop reordering is handled by `search_drag.js`.
*
* The `filter_model` contract:
*  - Group node:     { node_type:'group',     id, operator:'$and'|'$or', children:[], parent, dom }
*  - Component node: { node_type:'component', id, path, section_id, instance, parent, dom }
*  - The root node is `self.filter_model` (a group node; parent===null).
*  - `model_node_counter` is incremented monotonically to produce stable node ids.
*
* Callers:
*  - `section` instances — standard record-list area.
*  - `area_thesaurus` / `area_ontology` instances — thesaurus / ontology browsers.
*
* The `sqo` (Search Query Object) written to `caller.rqo.sqo` feeds the server
* PHP `search` class (core/search/class.search.php) which translates it into a
* parameterized JSONB SQL query.
*
* Main exports:
*  - `search` (constructor)
*  - `is_filter_empty` (re-exported from search_utils.js for consumer convenience)
*/

// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {is_empty} from '../../component_common/js/component_common.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {common} from '../../common/js/common.js'
	import {ui} from '../../common/js/ui.js'
	import {get_instance} from '../../common/js/instances.js'
	import {
		render_search
	} from './render_search.js'
	import {
		on_dragstart,
		on_dragover,
		on_dragleave,
		on_drop
	} from './search_drag.js'
	import {
		get_editing_preset_json_filter,
		load_default_preset,
		load_search_preset,
		save_temp_preset
	} from './search_user_presets.js'
	import {is_filter_empty} from './search_utils.js'
	import {response_data} from '../../common/js/api_error.js'
	import {has_embed_groups} from './render_semantic.js'
	export {is_filter_empty} from './search_utils.js'



/**
* SEARCH
* Constructor for the search controller.
*
* Instances are created by `get_instance` (core/common/js/instances.js) before
* `init()` is called.  The constructor is intentionally minimal — it only seeds
* `id_variant` and `model` so that the instance-registration machinery can
* distinguish search objects from component or section objects.
*
* `this.id` is set by `get_instance` immediately after construction and MUST
* NOT be overwritten in `init()` (see comment inside init).
*/
export const search = function() {

	this.id_variant	= null
	this.model		= 'search'

	return true
}//end search



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	// lifecycle
	search.prototype.refresh						= common.prototype.refresh
	search.prototype.destroy						= common.prototype.destroy
	// render
	search.prototype.render							= common.prototype.render
	search.prototype.list							= render_search.prototype.list
	search.prototype.edit							= render_search.prototype.list
	search.prototype.render_base					= render_search.prototype.render_base
	search.prototype.render_components_list			= render_search.prototype.render_components_list
	search.prototype.render_search_buttons			= render_search.prototype.render_search_buttons
	search.prototype.render_filter					= render_search.prototype.render_filter
	search.prototype.render_search_group			= render_search.prototype.render_search_group
	search.prototype.build_search_component			= render_search.prototype.build_search_component
	// phone. on_component_row decorates each field row; add_field_to_search adds
	// it on a tap (search_phone.js)
	search.prototype.on_component_row				= render_search.prototype.on_component_row
	search.prototype.add_field_to_search			= render_search.prototype.add_field_to_search
	// drag
	search.prototype.on_dragstart					= on_dragstart
	search.prototype.on_dragover					= on_dragover
	search.prototype.on_dragleave					= on_dragleave
	search.prototype.on_drop						= on_drop
	// user presets
	search.prototype.load_search_preset				= load_search_preset
	search.prototype.get_section_elements_context	= common.prototype.get_section_elements_context
	search.prototype.calculate_component_path		= common.prototype.calculate_component_path



/**
* INIT
* Initialises a search instance after it is created by `get_instance`.
*
* Sets up all runtime state — event subscriptions, DOM-pointer slots, the
* `filter_model` root, the component-exclusion list, and persistence keys.
*
* The `change_search_element` subscription drives the live-save loop:
* every time a bound component changes its value in the search UI the handler
* (1) re-serialises the filter model, (2) debounces a temp-preset save, and
* (3) adds/removes the highlight class on the component wrapper.
*
* Side effects:
*  - Pushes one event token into `self.events_tokens` (cleaned up by `destroy`).
*  - Sets `self.is_init = true` to guard against duplicate init calls.
*
* @param {Object} options
* @param {Object} options.caller - The section or area instance that owns this search.
* @param {string} options.mode   - Render mode, e.g. 'list' or 'edit'.
* @param {string} [options.lang] - Data language; falls back to `page_globals.dedalo_data_lang`.
* @returns {Promise<boolean>} Always resolves to `true`.
*/
search.prototype.init = async function(options) {

	const self = this

	// safe init double control. To detect duplicated events cases
		if (typeof this.is_init!=='undefined') {
			console.error('Duplicated init for element:', this);
			if(SHOW_DEBUG===true) {
				// (!) alert() here is intentional debug-only signaling; production code has
				// SHOW_DEBUG===false, so this branch is never reached in normal operation.
				alert('Duplicated init element');
			}
			return false
		}
		this.is_init = true

	// status update
		self.status = 'initializing'

	// options
		self.caller		= options.caller
		self.context	= options.caller.context
		self.mode		= options.mode
		self.lang		= options.lang || page_globals.dedalo_data_lang

	// short vars
		self.type					= 'filter'
		self.section_tipo			= self.caller.section_tipo
		self.events_tokens			= []
		self.ar_instances			= []
		self.parent_node			= null
		self.components_list		= {}
		self.source					= self.caller.rqo.source
		self.sqo					= self.caller.rqo.sqo
		// target_section_tipo: the section actually being searched, which may differ from
		// the caller's own section_tipo (e.g. area_thesaurus searches a thesaurus section,
		// not the area itself).
		self.target_section_tipo	= self.sqo.section_tipo // can be different to section_tipo like area_thesaurus
		// limit: records per page; prefers the SQO value, then mode-specific defaults,
		// then the persisted local-DB value restored in build().
		self.limit					= self.sqo.limit ?? (self.caller.mode==='edit' ? 1 : 10)
		self.search_layout_state	= null
		self.search_panel_is_open	= false

	// sections_selector_data
		self.sections_selector_data = typeof self.caller.get_sections_selector_data!=='undefined'
			? self.caller.get_sections_selector_data()
			: null

	// json_filter default value
		self.json_filter = {"$and": []};

	// semantic search state (RAG, 2026-07-22). The instance is keyed and cached
	// across re-renders, so both the list quick-input and the panel block render
	// from this one home. NEVER smuggled through sqo.filter (the server filter
	// schema strips unknown keys); presets carry it INSIDE the stored filter
	// value (parse_dom_to_json_filter attaches it in non-'search' modes only).
		self.semantic = {
			q		: '',	// the natural-language query
			group	: null,	// embed-group facet (null = all groups)
			pinned	: false	// a semantic result set is currently pinned
		}

	// filter_model. Canonical in-memory model and single source of truth for the
	// filter STRUCTURE (groups, operators, ordering and participating components).
	// The DOM is a rendering of this model; structural mutations flow through the
	// model helpers and serialization reads the model, never the DOM tree.
		self.filter_model		= null
		self.model_node_counter	= 0

	// DOM stored pointers
		self.wrapper							= null
		self.search_global_container			= null
		self.search_container_selector			= null
		self.search_group_container				= null
		self.search_container_selection_presets	= null
		self.wrapper_sections_selector			= null
		self.search_children_recursive_node		= null
		self.max_input 							= null
		// pending_group: the group a phone-added field should land in (set when a
		// group's "Add a field" slot is tapped; search_phone.js). Null = root.
		self.pending_group						= null

		self.node								= null

	// other
		// NOTE: self.id is the keyed instance id assigned by get_instance before
		// init runs. It must NOT be overwritten here: event channels (built_/render_/
		// destroy_/update_sections_list_) and the instances_map registration all
		// depend on it being unique per caller.
		self.section_id							= 0
		self.pagination_id 						= `${self.section_tipo}_${self.mode}`

	// panels_status_id. Stable, deliberately global namespace used to persist the
	// search UI panel open/close state. Decoupled from self.id so the preference
	// stays shared across sections (preserving the prior 'search'-keyed behavior).
		self.panels_status_id					= 'search'

		// ar_components_exclude. Custom list of elements to exclude in the left list (section fields)
		self.ar_components_exclude = [
			'component_3d',
			'component_av',
			'component_image',
			'component_pdf',
			'component_password',
			'component_security_access',
			'component_geolocation',
			'component_info',
			'component_inverse',
			'section_tab'
		];

	// events subscription
		// change_search_element. Update value, subscription to the changes: if the DOM input value was changed,
		// observers DOM elements will be changed own value with the observable value
		const change_search_element_handler = async (instance) => {
			// parse filter to DOM
			self.parse_dom_to_json_filter({
				mode : self.mode
			})
			// Set as changed, it will fire the event to save the temp search section (temp preset)
			dd_request_idle_callback(
				() => {
					self.update_state({
						state : 'changed'
					})
				}
			)
			// show save animation. add save_success class to component wrappers (green line animation)
			ui.component.exec_save_successfully_animation(instance)
			// set instance as changed or not based on their value

			// Check for first entry value
			const is_empty_value = is_empty(instance)

			// Check for operator
			const is_empty_operator = !instance.data?.q_operator

			// Highlight if either is present
			const hilite = ( !is_empty_value || !is_empty_operator )

			ui.hilite({
				instance	: instance, // instance object
				hilite		: hilite // bool
			})
		}
		self.events_tokens.push(
			event_manager.subscribe('change_search_element', change_search_element_handler)
		)

	// permissions
		self.permissions = 2

	// ar_resolved_elements
		self.ar_resolved_elements = []

	// leaf_builds. Pending filter row builds of the last render_filter
		self.leaf_builds = []

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Load from API the user editing_preset (current state) and user_presets (stored states)
*
* Runs two parallel async operations before the search UI is rendered:
*
*  1. Fetch the "temp preset" (section dd655) for the current user and
*     section_tipo.  If found, the stored `json_filter` is restored into
*     `self.json_filter` so the filter panel re-opens with the user's last
*     in-progress filter.
*
*  2. Fetch the persisted pagination limit from the local IndexedDB store.
*     If found, `self.limit` is overridden so the last-used page size is kept.
*
* Both are wrapped in `Promise.allSettled` so a failure in one does not
* prevent the other from completing.  Errors are stored in `self.error` and
* logged, but do not prevent the UI from loading with defaults.
*
* @returns {Promise<boolean>} Resolves to `true` when both requests settle.
*/
search.prototype.build = async function() {

	const self = this

	// status update
		self.status = 'building'

	// ar_promises
		const ar_promises = []

	try {

		// editing_preset. Get json_filter from DDBB temp presets section
		ar_promises.push( new Promise(function(resolve){

			get_editing_preset_json_filter(self)
			.then(async function(json_filter){

				// debug
				if(SHOW_DEBUG===true) {
					if (!json_filter) {
						console.log(
							'[search.build] No preset was found (search editing_preset). Using default filter:',
							self.section_tipo, json_filter
						);
					}
				}

				// Override self.json_filter if json_filter is valid
				if (json_filter && typeof json_filter === 'object' && Object.keys(json_filter).length > 0) {
					self.json_filter = json_filter;
					// semantic (RAG): the temp preset stores the live NL query
					// inside the filter value — restore it into instance state
					// (state only; the user's Apply re-runs it live).
					if (json_filter.semantic && typeof json_filter.semantic.q === 'string') {
						self.semantic.q		= json_filter.semantic.q
						self.semantic.group	= json_filter.semantic.group || null
					}
				}

				// DEFAULT PRESET (dd641): when there is NO in-progress filter (the
				// temp preset carries no q leaf and no semantic query), seed the
				// initial filter from the user's default named preset for this
				// section, if any. An in-progress temp filter always wins.
				const has_semantic	= typeof self.json_filter?.semantic?.q === 'string' && self.json_filter.semantic.q.trim() !== ''
				if (!has_semantic && is_filter_empty(self.json_filter)) {
					try {
						const default_filter = await load_default_preset(self)
						if (default_filter && !is_filter_empty(default_filter)) {
							self.json_filter = default_filter
							if (default_filter.semantic && typeof default_filter.semantic.q === 'string') {
								self.semantic.q		= default_filter.semantic.q
								self.semantic.group	= default_filter.semantic.group || null
							}
						}
					} catch(error) {
						console.error('[search.build] load_default_preset failed:', error)
					}
				}

				resolve(self.json_filter)
			})
		}))

		// pagination data. Get limit from local DB
		ar_promises.push( new Promise(function(resolve){

			data_manager.get_local_db_data(self.pagination_id, 'pagination')
			.then(function(local_data){
				if (local_data?.value?.limit) {
					self.limit = local_data.value.limit
				}
				resolve(self.limit)
			})
		}))

		// section elements. Started here, in parallel with the presets, so list()
		// joins the memoized request instead of waiting another round trip
		ar_promises.push( self.get_section_elements({
			use_real_sections : self.caller.model!=='section'
		}) )

		// wait until all request are resolved or rejected
		await Promise.allSettled(ar_promises);

	} catch (error) {
		self.error = error
		console.error(error)
	}


	// status update
		self.status = 'built'


	return true
}//end build



/**
* UPDATE_LOCAL_DB_PAGINATION
* Updates the pagination limit and offset values in the local database storage.
* This function persists the current pagination settings so they can be restored
* when the search is rebuilt or the page is reloaded.
*
* Reads the existing record under the key `self.pagination_id` in the
* `'pagination'` store.  If a record exists it is updated in place; otherwise a
* fresh record is created.  In both cases `self.limit` and `self.offset` (or 0)
* are written so they match the live state.
*
* @returns {Promise<void>} Resolves when the local DB is updated.
*/
search.prototype.update_local_db_pagination = async function() {

	const self = this

	// Get existing pagination data from local DB
	const local_db_data = await data_manager.get_local_db_data(self.pagination_id, 'pagination')

	if(local_db_data) {
		// Update the limit value with current search limit
		local_db_data.value.limit = self.limit

		// Update the offset value with current search offset
		local_db_data.value.offset = self.offset || 0

		// Save the updated pagination data back to local DB
		await data_manager.set_local_db_data(local_db_data, 'pagination')

	} else {
		// Create new pagination data if none exists
		const new_pagination_data = {
			id : self.pagination_id,
			value : {
				limit: self.limit,
				offset: self.offset || 0
			}
		}
		await data_manager.set_local_db_data(new_pagination_data, 'pagination')
	}
}



/**
* GET_SECTION_ELEMENTS
* Returns the list of section elements (field descriptors) available to build
* the search filter UI.
*
* Delegates to `get_section_elements_context` (from `common.prototype`) which
* fetches ontology field metadata for `target_section_tipo`, excluding any
* component models listed in `ar_components_exclude` (e.g. binary media
* components that cannot be meaningfully searched).
*
* The `caller_tipo` is forwarded so the server can skip permission checks when
* the caller is an area_thesaurus (which has a higher trust level than a plain
* section user).
*
* @param {Object} [options={}] - Additional overrides merged over the defaults.
* @returns {Promise<Array>} Resolves with the array of section element descriptors.
*/
search.prototype.get_section_elements = async function(options) {

	const self = this

	const default_options = {
		section_tipo			: self.target_section_tipo,
		ar_components_exclude	: self.ar_components_exclude,
		caller_tipo				: self.caller.tipo // used to skip permissions when caller is area_thesaurus
	}

	// section_elements_options
	const section_elements_options = Object.assign({}, default_options, options);

	const section_elements = await self.get_section_elements_context(section_elements_options)


	return section_elements
}//end get_section_elements



/**
* DES LOAD_COMPONENT_CONTEXT
* Call to dd_core_api to obtain the list of components associated to current options section_tipo
* @param object options
*	string options.section_tipo
* @return promise
*/
	// search.prototype.load_component_context = async function(options) {

	// 	const self = this

	// 	// vars
	// 		const section_tipo 	= options.section_tipo

	// 	// components
	// 		const get_components = async () => {
	// 			if (self.components_list[section_tipo]) {

	// 				return self.components_list[section_tipo]

	// 			}else{

	// 				// load data
	// 					const api_response = await data_manager.request({
	// 						body : {
	// 							action			: "get_section_components",
	// 							ar_section_tipo	: [section_tipo]
	// 						}
	// 					})

	// 				// fix
	// 					self.components_list[section_tipo] = api_response.result

	// 				return api_response.result
	// 			}
	// 		}
	// 		const components = get_components()


	// 	return components
	// }//end load_component_context



/**
* DES CALCULATE_COMPONENT_PATH
* Resolve component full search path. Used to build json_search_object and
* create later the filters and selectors for search
* @param object element
*	Contains all component data collected from trigger
* @param array path
*	Contains all paths prom previous click loads
* @return array component_path
*	Array of objects
*/
	// search.prototype.calculate_component_path = function(component_context, path) {

	// 	if (!Array.isArray(path)) {
	// 		console.log("[search2.calculate_component_path] Fixed bad path as array! :",path);
	// 		path = []
	// 	}

	// 	const calculate_component_path = []

	// 	// Add current path data
	// 	const path_len = path.length
	// 	for (let i = 0; i < path_len; i++) {
	// 		calculate_component_path.push(path[i])
	// 	}

	// 	// Add component path data
	// 	calculate_component_path.push({
	// 		section_tipo 	: component_context.section_tipo,
	// 		component_tipo 	: component_context.tipo,
	// 		model  			: component_context.model,
	// 		name  			: component_context.label.replace(/<[^>]*>/g, '')
	// 	})

	// 	return calculate_component_path
	// }//end calculate_component_path



/**
* GET_SECTION_ID
* Returns a monotonically incrementing synthetic section id for use as a
* temporary key for filter-row component instances inside the search UI.
*
* Each component row added to the search filter requires a unique section_id
* so that `get_instance` can create a distinct keyed instance for it.  The
* generated ids are local to this search instance and are never persisted or
* sent to the server as real section identifiers.
*
* Format: `'search_<n>'` where `<n>` starts at 1 and increments by one per call.
*
* @returns {string} Unique temporary section id string.
*/
search.prototype.get_section_id = function() {

	const self = this

	// increment self section_id value
	self.section_id = ++self.section_id

	// build temp name
	// const temp_section_id = 'tmp_search_' + self.section_id
	const temp_section_id = 'search_' + self.section_id

	return temp_section_id
}//end get_section_id



// MODEL (canonical filter structure)
// These helpers own the in-memory model tree. Group nodes hold an operator and
// an ordered children array (groups + components); component nodes reference the
// row's component instance and its search path. The DOM created in render_search
// links back to each node (node.dom / dom.__node) so drag&drop still operates on
// the DOM while the model stays authoritative.



	/**
	* CREATE_GROUP_MODEL_NODE
	* Creates and registers a new group node in the filter model tree.
	*
	* A group node is the container for a logical operator ($and / $or) applied
	* to all of its children.  If a parent node is provided the new group is
	* appended to `parent_node.children` immediately.
	*
	* The `dom` reference is set later by the render layer once the corresponding
	* `.search_group` element is created; it is wired here as `null` (or supplied
	* by the caller if already available).
	*
	* @param {string}          operator    - Logical operator: '$and' or '$or'.
	* @param {Object|null}     parent_node - Parent group model node; null for root.
	* @param {HTMLElement|null} dom        - The corresponding DOM `.search_group` element.
	* @returns {Object} Newly created group node.
	*/
	search.prototype.create_group_model_node = function(operator, parent_node, dom) {

		const node = {
			node_type	: 'group',
			id			: ++this.model_node_counter,
			operator	: operator || '$and',
			children	: [],
			parent		: parent_node || null,
			dom			: dom || null
		}

		if (parent_node) {
			parent_node.children.push(node)
		}

		return node
	}//end create_group_model_node



	/**
	* CREATE_COMPONENT_MODEL_NODE
	* Creates and registers a new component (leaf) node in the filter model tree.
	*
	* A component node represents one filter row: a specific field (`path`) with
	* its bound component instance.  The node is appended to `options.parent_node`
	* if provided.  The `instance` reference is filled in after `get_component_instance`
	* resolves; until then it may be null.
	*
	* @param {Object}           options             - Node initialisation data.
	* @param {Array|null}       options.path        - Component path array (section+component tipo pairs).
	* @param {string|null}      options.section_id  - Temporary section id for the row instance.
	* @param {Object|null}      options.instance    - Bound component instance (may be set after creation).
	* @param {Object|null}      options.parent_node - Parent group node; null for detached nodes.
	* @param {HTMLElement|null} options.dom         - Corresponding DOM row element.
	* @returns {Object} Newly created component node.
	*/
	search.prototype.create_component_model_node = function(options) {

		const node = {
			node_type	: 'component',
			id			: ++this.model_node_counter,
			path		: options.path || null,
			section_id	: options.section_id || null,
			instance	: options.instance || null,
			parent		: options.parent_node || null,
			dom			: options.dom || null
		}

		if (options.parent_node) {
			options.parent_node.children.push(node)
		}

		return node
	}//end create_component_model_node



	/**
	* REMOVE_MODEL_NODE
	* THE teardown door of the filter model: detaches a node (group or component)
	* from its parent's children array AND destroys every component instance
	* bound in the removed subtree, splicing each out of `self.ar_instances`.
	*
	* Until 2026-09-04 this only spliced the model, with a note that "callers are
	* responsible for calling instance.destroy()". The ROW close button did; the
	* GROUP close button did not, so removing a group leaked every instance
	* inside it: still in the global registry (whose only removal path is the
	* destroy chain), still answering their render/sync subscriptions, and — since
	* the search instance key is minted with a timestamp — unreusable by
	* construction. `reset()` then iterated the still-polluted list and refreshed
	* each orphan against a DOM node no longer in the document. One door, walked
	* recursively, removes the class of defect instead of the instance of it: a
	* caller that also destroys (the row handler's own splice + destroy) finds the
	* instance already gone and is a no-op.
	*
	* Locates the node by reference using `indexOf`. Returns `false` without
	* mutating anything if the node has no parent or the parent's children is
	* not an array (e.g. already removed or detached root).
	*
	* @param {Object} node - The group or component model node to remove.
	* @returns {boolean} `true` if removed; `false` if no parent or node not found.
	*/
	search.prototype.remove_model_node = function(node) {

		const self = this

		const parent = node?.parent
		if (!parent || !Array.isArray(parent.children)) {
			return false
		}

		const index = parent.children.indexOf(node)
		if (index!==-1) {
			parent.children.splice(index, 1)
		}

		// destroy the bound instances of the whole subtree. Detach from the
		// model FIRST (above) so a destroy that re-enters here finds nothing.
		self.destroy_model_subtree(node)

		return true
	}//end remove_model_node



	/**
	* DESTROY_MODEL_SUBTREE
	* Walks a model node and its descendants; every bound component instance is
	* spliced from `self.ar_instances` and destroyed (self + dependencies, the
	* wrapper DOM is removed by the caller with the group/row node). The walk is
	* depth-first over `children`, so nested groups are covered; a component
	* node whose instance was never bound (closed while still building) has
	* nothing to destroy.
	*
	* @param {Object} node - A group or component model node.
	* @returns {number} instances destroyed
	*/
	search.prototype.destroy_model_subtree = function(node) {

		const self = this

		if (!node) {
			return 0
		}

		let destroyed = 0

		// own instance (component node)
			const instance = node.instance
			if (instance && typeof instance.destroy==='function') {
				node.instance = null
				const index = self.ar_instances.findIndex(item => item===instance || item.id===instance.id)
				if (index!==-1) {
					self.ar_instances.splice(index, 1)
				}
				instance.destroy(
					true, // delete_self
					true, // delete_dependencies
					false // remove_dom
				)
				destroyed++
			}

		// children (group node) — iterate over a copy: a destroy may detach nodes
			const children = Array.isArray(node.children) ? node.children.slice() : []
			for (let i = 0; i < children.length; i++) {
				destroyed += self.destroy_model_subtree(children[i])
			}

		return destroyed
	}//end destroy_model_subtree



	/**
	* MOVE_MODEL_NODE
	* Reorders a node within its parent's children array by swapping it with an
	* adjacent sibling, mirroring the DOM drag-and-drop reorder behaviour.
	*
	* Only swaps with an adjacent node whose `node_type === 'component'`.  Group
	* nodes are not swapped (matching the DOM guard in `build_search_component`).
	* Returns `false` without mutation if the neighbor does not exist or is not a
	* component node.
	*
	* This does not re-render the DOM; callers must update the DOM independently
	* (drag-and-drop updates the DOM first, then calls this to keep the model in
	* sync).
	*
	* @param {Object} node      - The model node to move.
	* @param {string} direction - 'up' to swap with the previous sibling; 'down' for the next.
	* @returns {boolean} `true` if the swap happened; `false` otherwise.
	*/
	search.prototype.move_model_node = function(node, direction) {

		const parent = node?.parent
		if (!parent || !Array.isArray(parent.children)) {
			return false
		}

		const children	= parent.children
		const index		= children.indexOf(node)
		if (index===-1) {
			return false
		}

		const neighbor_index	= direction==='up' ? index-1 : index+1
		const neighbor			= children[neighbor_index]
		// only swap with an adjacent component (same guard as the DOM handler)
		if (!neighbor || neighbor.node_type!=='component') {
			return false
		}

		children[neighbor_index]	= node
		children[index]				= neighbor

		return true
	}//end move_model_node



/**
* BUILD_DOM_GROUP
* Recursively walks a `json_filter` object (in the canonical `{$and:[…]}` /
* `{$or:[…]}` shape) and creates the corresponding DOM structure and component
* instances.
*
* Used on initial load to reconstruct the filter UI from a persisted preset.
* The recursion mirrors the shape of the json_filter tree:
*
*  - A node whose key is `'path'` is a filter leaf: calls `build_search_component`
*    to instantiate the component and add it to the DOM.
*  - A node whose key starts with `'$'` is a group: calls `render_search_group`
*    to create the DOM group container, then recurses into its children array.
*
* The `ar_resolved_elements` array tracks which temporary section_ids have
* already been added, preventing duplicate filter rows from appearing when the
* same component appears more than once in the preset.
*
* @param {Object}      filter      - A json_filter node (group or leaf shape).
* @param {HTMLElement} dom_element - The DOM element to append children to.
* @param {Object}      [options={}]
* @param {boolean}     [options.allow_duplicates=false] - When true, skip the dedup guard.
* @param {boolean}     [options.clean_q=false]          - When true, clear `q`/`q_operator`/`lang` values
*                                                         (used when loading a preset as a template).
* @param {boolean}     [options.is_root=false]          - Whether this call is for the root group node.
* @returns {HTMLElement|null} The last-created DOM group element, or null for leaf nodes.
*/
search.prototype.build_dom_group = function(filter, dom_element, options={}) {

	const self = this

	// options
		const allow_duplicates	= options.allow_duplicates || false
		const clean_q			= options.clean_q || false
		const is_root			= options.is_root || false

	let dom_group = null

	for (const key in filter) {

		// Case is component, only add when key is path
		if (key==='path') {

			let current_value	= filter.q
			let q_operator		= filter.q_operator
			let q_lang			= filter.lang

			// Resolved check (useful for sequences or split strings)
			const section_id = self.get_section_id()

			if (self.ar_resolved_elements.indexOf(section_id)===-1) {

				if (clean_q===true) {
					current_value	= ''
					q_operator		= ''
					q_lang 			= null
				}

				// Add. If not already resolved, add. list() awaits leaf_builds to reveal the panel once
				self.leaf_builds.push( self.build_search_component({
					parent_div		: dom_element,
					path_plain		: JSON.stringify(filter.path),
					entries			: current_value,
					q_operator		: q_operator,
					q_lang			: q_lang,
					section_id		: section_id
				}) )

				// Set as resolved
				if (allow_duplicates!==true) {
					self.ar_resolved_elements.push(section_id)
				}
			}

		// If key contains $ is a group
		}else if (key.indexOf('$')!==-1) {

			// Case is group
				const ar_data = filter[key]

			// Build DOM search_group
				const current_search_group = self.render_search_group( dom_element, {
					operator	: key,
					is_root		: is_root
				})

			// Recursions
				const ar_data_len = ar_data.length
				for (let i = 0; i < ar_data_len; i++) {
					const current_json_object = ar_data[i]
					options.is_root = false
					self.build_dom_group(current_json_object, current_search_group, options)
				}
		}
	}//end for (const key in filter)


	return dom_group
}//end build_dom_group



/**
* GET_COMPONENT_INSTANCE
* Creates, builds, and configures a component instance for use as a filter row
* in the search UI.
*
* Called by `render_search.build_search_component` when a user adds a field
* to the filter panel.  The flow is:
*
*  1. Derive a unique key from section_tipo + section_id + component_tipo + lang
*     + `performance.now()` to guarantee no collision with other instances or
*     previous runs.
*  2. Call `get_instance` to create the component instance.
*  3. Inject `entries` before calling `build()` so portal components can use
*     them in their `resolve_data` API call.
*  4. Call `build(true)` (autoload=true). If it returns `false` the component is
*     unusable (e.g. missing ontology entry) and null is returned.
*  5. Re-inject `entries` after build (non-portal components may have reset them).
*  6. Inject `permissions = 2` (full read/write) because the search filter is
*     always editable regardless of the user's record permissions.
*  7. Inject `q_operator`, `q_lang`, and the resolved `path` into `instance.data`.
*  8. Register the instance in `self.ar_instances` for lifecycle management.
*
* The commented-out `context` and `source_add` blocks are retained as dead code
* for reference; do not remove without reviewing the portal path.
*
* @param {Object}       options
* @param {string}       options.section_id              - Temporary section id for the row.
* @param {string}       options.section_tipo            - Section tipo the component belongs to.
* @param {string}       options.component_tipo          - Component tipo (ontology identifier).
* @param {string}       options.model                   - Component model name, e.g. 'component_input_text'.
* @param {Array}        [options.entries=[]]            - Pre-loaded search value entries.
* @param {string|null}  [options.q_operator]            - Search operator (e.g. 'AND', 'OR', 'NOT').
* @param {string|null}  [options.q_lang]                - Language override for the search query.
* @param {Array}        options.path                    - Component path array describing field nesting.
* @param {Array|null}   [options.ar_target_section_tipo] - (Currently unused; retained for future portal filtering.)
* @returns {Promise<Object|null>} The fully initialised component instance, or null if build failed.
*/
search.prototype.get_component_instance = async function(options) {

	const self = this

	// options
		const section_id				= options.section_id
		const section_tipo				= options.section_tipo
		const component_tipo			= options.component_tipo
		const model						= options.model
		const entries					= options.entries || []
		const q_operator				= options.q_operator
		const q_lang					= options.q_lang
		const path						= options.path
		const ar_target_section_tipo	= options.ar_target_section_tipo

	// instance
		// instance key. Custom to get unique key
			const lang		= page_globals.dedalo_data_lang
			const serial	= performance.now()
			const key		= section_tipo +'_'+ section_id +'_'+ component_tipo +'_search_'+ lang +'_'+ serial
		// context
			// const context = {
			// 	model			: model,
			// 	type			: 'component',
			// 	tipo			: component_tipo,
			// 	section_tipo	: section_tipo,
			// 	section_id		: section_id,
			// 	mode			: 'search',
			// 	permissions		: 2
			// }
		// instance
			const component_options = {
				key				: key,
				model			: model,
				tipo			: component_tipo,
				section_tipo	: section_tipo,
				section_id		: section_id,
				mode			: 'search',
				lang			: lang
			}
			const component_instance = await get_instance(component_options)
			if (!component_instance) {
				// stored model with no client module (e.g. a stale preset leaf)
				console.error('Ignored search component, no instance for model:', model, component_tipo)
				return null
			}

	// discard. A leaf that cannot be built is destroyed here (it is already in the
	// instances registry). Proven stale (tipo gone, model changed) → null, the one
	// 'invalid' contract of the caller; any other failure (transport, timeout, 5xx,
	// session) rethrows, so the caller keeps the condition instead of repair-saving it away.
		const discard = async (stale, reason, error) => {
			console.error('Ignored search component instance:', reason, {section_tipo, component_tipo, model}, error ?? '')
			try {
				await component_instance.destroy(true)
			} catch (destroy_error) {
				console.error('get_component_instance: destroy failed', destroy_error)
			}
			if (!stale) {
				throw error || new Error(reason)
			}
			return null
		}

	// data. Inject entries from search user preset before build is needed for portal 'resolve_data' API call.
		component_instance.data = {
			entries : entries
		}

	// Include ar_target_section_tipo to the source to get the specific sections define by the selection of the user
	// used by component_relation_model to define his own sections.
		// component_instance.source_add = {
		// 	ar_target_section_tipo : ar_target_section_tipo
		// }

	// build component to force load datalist, portal resolve_data etc.
		// A stale preset leaf (tipo gone from the ontology) rejects with request.invalid_tipo.
		try {
			const build_result = await component_instance.build(true)
			if(build_result===false){
				return discard(false, 'build result is false')
			}
		} catch (error) {
			return discard(error?.code==='request.invalid_tipo', 'build failed', error)
		}
		// context comes from the server's CURRENT ontology: a model other than the
		// stored one means the model changed or the tipo was recycled.
		const current_model = component_instance.context?.model
		if (current_model !== model) {
			return discard(!!current_model, 'model mismatch, current: ' + current_model)
		}

	// data. Inject entries from search user preset after build again for non portal components.
		component_instance.data.entries = entries

	// permissions. Inject permissions. Search is always enable for all users
		component_instance.context.permissions = 2

	// add search options to the instance
		component_instance.data.q_operator	= q_operator
		component_instance.data.q_lang		= q_lang
		component_instance.path				= path

	// add instance
		self.ar_instances.push(component_instance)


	return component_instance
}//end get_component_instance



// GET the SQO from DOM components



/**
* PARSE_DOM_TO_JSON_FILTER
* Produces the full `json_query_obj` expected by `update_caller` by serialising
* the current `filter_model` tree.
*
* This is the outer entry point for filter serialisation.  It wraps
* `serialize_filter_model` (which produces the `{$and:[…]}` structure) with:
*  - The `id` / `filter` envelope.
*  - The `children_recursive` flag read from the dedicated checkbox DOM node.
*
* The `mode` parameter controls whether empty-value filter rows are included:
*  - `'search'`   — only rows with a non-null `q` or non-empty `q_operator` are emitted.
*  - any other    — all rows are emitted (used when saving a preset that should
*                   preserve the selected fields even without values).
*
* The `save_arguments` option is a string `'true'`/`'false'` parsed into a
* boolean that controls whether `q` values are serialised.  Passing `'false'` is
* used when saving a "template" preset (field structure only, no values).
*
* @param {Object}           options
* @param {string}           options.mode              - Serialisation mode: 'search' or 'default'.
* @param {string|undefined} [options.save_arguments]  - String 'true'/'false'; controls value inclusion.
* @returns {Object} `json_query_obj` shape: `{ id, filter, [children_recursive] }`.
*/
search.prototype.parse_dom_to_json_filter = function(options) {

	const self = this

	// Mode. Used to indicate that q values for search must be converted to usable search values by the components (search)
	const mode				= options.mode || 'default'
	const save_arguments	= options.save_arguments

	// json_query_obj
		const json_query_obj = {
			id		: 'temp',
			filter	: {}
		}

	// First level. Canonical model root (no longer derived by walking the DOM)
		const root_node = self.filter_model

	// Add arguments. Used to exclude search arguments on save preset in this mode
		const add_arguments = typeof save_arguments!=='undefined' && (save_arguments==='true' || save_arguments==='false')
			? JSON.parse(save_arguments)
			: true

	// Serialize the model tree to the json filter group object. With NO model
	// built (panel never opened — e.g. the semantic quick input firing first),
	// fall back to the RESTORED json_filter instead of an empty tree: an empty
	// serialization here would silently DESTROY a session/preset filter the
	// user can see acting on the list (exec_search) or overwrite the stored
	// temp preset server-side (autosave) — devil-review #4, 2026-07-22.
		const filter_obj = root_node
			? self.serialize_filter_model(root_node, add_arguments, mode)
			: (self.json_filter && Array.isArray(self.json_filter.$and)
				? self.json_filter
				: {"$and": []})
		if(SHOW_DEBUG===true) {
			console.warn("[parse_dom_to_json_filter] filter_obj: ", filter_obj);
		}

	// children_recursive checkbox (UI-only toggle, read from the DOM control)
		if (self.search_children_recursive_node) {
			const children_recursive_node = self.search_children_recursive_node
			json_query_obj.children_recursive = children_recursive_node.checked===true
		}

	// Add object with groups to filter array
		json_query_obj.filter = filter_obj

	// semantic (RAG, 2026-07-22): presets carry the LIVE natural-language query
	// inside the stored filter value — attached ONLY in non-'search' modes (both
	// preset save paths), so it never rides the wire SQO from exec_search (the
	// server filter schema would strip it anyway) and the resolved pins/order
	// are NEVER frozen into a preset (they would freeze one user's result set
	// into a shareable record). build_dom_group ignores non-path/non-$ keys, so
	// old clients render presets carrying it without harm.
		if (mode!=='search' && self.semantic && self.semantic.q && self.semantic.q.trim()!=='') {
			json_query_obj.filter.semantic = {
				q		: self.semantic.q,
				group	: self.semantic.group
			}
		}


	return json_query_obj
}//end parse_dom_to_json_filter



/**
* SERIALIZE_FILTER_MODEL
* Walk the canonical model tree producing the json filter group object.
* Replaces the former DOM-walking recursive_groups: the structure comes from the
* model, while each component value is read from its bound instance.
*
* Called recursively: sub-group nodes call `serialize_filter_model` for their
* own subtree, component nodes call `get_search_value` to read the live value.
*
* `get_search_value` inner function:
*  - Prefers the component's own `get_search_value()` method (present on portal
*    and relation components to strip locator properties not needed by the query).
*  - Falls back to `component.data.entries` for simple components.
*  - Normalises entries to `{value, id:1}` objects (id is always 1 for search).
*
* In `mode === 'search'`:
*  - Rows where both `q` and `q_operator` are effectively empty are skipped so
*    the server does not receive no-op filter clauses.
*  - Rows that have an operator but no value use the special sentinel `q:'only_operator'`
*    which the PHP search class interprets as a pure-operator filter (e.g.
*    "has any value").
*
* In any other mode (preset save):
*  - All rows are emitted, including empty ones, to preserve the field structure.
*
* @param {Object}  group_node    - Current group node from the filter model.
* @param {boolean} add_arguments - When false, `q`/`q_operator` are not read from instances
*                                  (structure-only serialisation for template presets).
* @param {string}  mode         - 'search' (emit non-empty only) or 'default' (emit all).
* @returns {Object} Serialised filter group: `{ $and: […] }` or `{ $or: […] }`.
*/
search.prototype.serialize_filter_model = function(group_node, add_arguments, mode) {

	const self = this

	// Validate input
	if (!group_node) {
		console.error('Error: group_node is required');
		return {};
	}

	const operator = group_node.operator || '$and'

	const query_group = {}
		  query_group[operator] = []

	// get_search_value. Get the search value from the component or apply the default method
	const get_search_value = (component) => {

		const safe_entries = (typeof component.get_search_value === 'function')
			? component.get_search_value() || []
			: component.data?.entries || []

		const parsed_entries = safe_entries.map(entry => {
			if(!entry) {
				return
			}

			if(typeof entry !== 'object') {
				entry = {
					value : entry
				}
			}

			// fixed id for search presets
			entry.id = 1

			return entry
		})

		// value is into the data.entries array
		return parsed_entries;
	}

	const children	= group_node.children || []
	const len		= children.length
	for (let i = 0; i < len; i++) {

		const child = children[i]

		// sub group → recursion
		if (child.node_type==='group') {
			query_group[operator].push( self.serialize_filter_model(child, add_arguments, mode) )
			continue
		}

		// component node
		// Q . Search argument
		let q			= null // default
		let q_operator	= null // default
		let q_split		= false // default is false
		let q_lang		= null // default is null

		// add_arguments . if true, calculate and save inputs value to preset (temp preset)
		if (add_arguments !== false) {

			const component_instance = child.instance
			if(!component_instance){
				console.error('Error. Ignored model node without bound instance:', child.id);
				continue
			}

			// get the search value
			// if the component has a specific function get the value from his function (ex: portal remove some properties from his locator before search)
			// else get the value as search value.
			const search_value = get_search_value(component_instance);
			if(SHOW_DEBUG) {
				console.log("[serialize_filter_model] search_value:", search_value);
			}

			// overwrite
			q			= (search_value && search_value.length > 0) ? search_value : null
			q_operator	= component_instance.data.q_operator

			// q_split
			q_split = component_instance.q_split ?? false

			// lang
			//if the component is translatable it can set if the search is with all langs or selective(null) only for the current lang
			q_lang = component_instance.data.q_lang ?? null
		}

		// path from the model node
		const path = child.path
		if (!path) {
			console.error('Invalid path in model node:', child.id);
			continue
		}

		// create the search options with the component data.
		const search_options = {
			q			: q,
			q_operator	: q_operator,
			path		: path,
			q_split		: q_split,
			type		: 'jsonb'
		}

		// set the lang only when the component has this option.
		if(q_lang){
			search_options.lang = q_lang
		}

		// Add component
		if ( mode === 'search' ) {

			// Add only if not empty

			// Normalize q to always work with arrays for consistency
			const q_array = Array.isArray(q) ? q : [q];

			// Check for valid query content
			const has_valid_query = (
				q_array.length > 0 &&
				q_array[0] !== null &&
				q_array[0] !== undefined &&
				q_array[0] !== '' &&
				q_array[0] !== false
			) || q === 0;

			// Check for valid operator
			const has_valid_operator = q_operator && q_operator.length > 0;

			// Proceed if we have either valid query or operator
			if (has_valid_query || has_valid_operator) {
				// If no valid query but we have an operator, set placeholder
				if (!has_valid_query && has_valid_operator) {
					// Overwrites q
					search_options.q = 'only_operator';
				}

				// Add search_options value
				query_group[operator].push(search_options);
			}

		}else{
			// Add always
			query_group[operator].push(search_options)
		}

	}//end for (let i = 0; i < len; i++)


	return query_group
}//end serialize_filter_model



/**
* GET_SEARCH_JSON_OBJECT
* Resolve and configure the final search JSON object used for build SQL query
* @return object search_json_object
*/
	// this.get_search_json_object = function() {

	// 	const self = this

	// 	// Always blur active component to force set dato Important (!)
	// 		document.activeElement.blur()

	// 	// json_filter
	// 		const json_filter = self.parse_dom_to_json_filter({
	// 			mode : "search"
	// 		})

	// 	// global_container
	// 		const search2_global_container 	= document.getElementById("search2_global_container")
	// 		const max_input 				= search2_global_container.querySelector("input.max_input")
	// 		//const select_path 			= decodeURIComponent(search2_global_container.dataset.select_path)
	// 		//const select 					= JSON.parse(select_path)

	// 	// mode default
	// 		const mode = "list"

	// 	// table_rows_list base search options
	// 		// Changed 21-03-2018
	// 		const table_rows_list 			= document.querySelector(".table_rows_list")
	// 		const search_options  			= decodeURIComponent(table_rows_list.dataset.search_options)
	// 		const search_options_object 	= JSON.parse(search_options)
	// 		const base_search_query_object 	= search_options_object.search_query_object

	// 		const select 					= base_search_query_object.select
	// 		let section_tipo 	  			= base_search_query_object.section_tipo

	// 	// Thesaurus mode
	// 		if (self.mode==="thesaurus") {
	// 			// Selected sections to search. From checkboxes
	// 			const wrapper_sections_selector_ul = document.getElementById("wrapper_sections_selector_ul")
	// 			const ar_checkboxes = wrapper_sections_selector_ul.querySelectorAll("input")
	// 			let ar_sections = []
	// 			const ar_checkboxes_len = ar_checkboxes.length
	// 			for (let i = 0; i < ar_checkboxes_len; i++) {
	// 				if(ar_checkboxes[i].checked === true) {
	// 					ar_sections.push(ar_checkboxes[i].value)
	// 				}
	// 			}
	// 			//console.log("ar_sections:",ar_sections);
	// 			if (ar_sections.length<1) {
	// 				alert("Please select at least one section to search")
	// 				return false
	// 			}
	// 			// Replace search_query_object section with user selected values
	// 			section_tipo = ar_sections
	// 		}

	// 	// Final search_json_object
	// 	const search_json_object = {
	// 			id 			 : base_search_query_object.id, //section_tipo + "_" + mode,
	// 			mode 		 : mode,
	// 			parsed 		 : false,
	// 			section_tipo : section_tipo,
	// 			limit 		 : parseInt(max_input.value) || 10,
	// 			offset 		 : 0,
	// 			type 		 : "search_json_object",
	// 			//context 	 : {context_name:false},
	// 			full_count   : (self.mode==="thesaurus") ? false : true,
	// 			order 	 	 : false,
	// 			filter 		 : json_filter.filter,
	// 			select 		 : select
	// 		}

	// 	return search_json_object
	// }//end get_search_json_object



/**
* UPDATE_STATE
* Handles UI state transitions and persists the current filter as a temp preset.
*
* Called after any structural or value change to the filter model.  Responsibilities:
*
*  1. Records the new layout state in `self.search_layout_state`.
*  2. If a specific `editing_section_id` is provided (preset selection is active),
*     stores it and its `save_arguments` flag in the preset selector DOM element's
*     dataset.
*  3. Shows or hides the "Save preset" button: visible only when the state is
*     `'changed'` AND a named user preset is currently loaded (`self.user_preset_section_id`).
*  4. When `state === 'changed'`, calls `save_temp_preset` to asynchronously
*     persist the current filter to the server (section dd655).
*
* @param {Object}      options
* @param {string}      options.state                 - New state string, e.g. 'changed'.
* @param {string|null} [options.editing_section_id]  - Section id of the preset being edited.
* @param {string|null} [options.editing_save_arguments] - Serialised boolean string for preset save mode.
* @returns {Promise<boolean>} Resolves to `true` after all side effects complete.
*/
search.prototype.update_state = async function(options) {

	const self = this

	// options
		const state						= options.state // string
		const editing_section_id		= options.editing_section_id || null // string|null
		const editing_save_arguments	= options.editing_save_arguments || null // string|null

	// fix vars
		self.search_layout_state = state

	// search_container_selection_presets. Store current editing section_id in search_container_selection_presets dataset
		const search_container_selection_presets = self.search_container_selection_presets

	// editing_section_id case
		if (editing_section_id) {
			// Set dataset section_id
			search_container_selection_presets.dataset.section_id = editing_section_id
			// Set dataset save_arguments
			search_container_selection_presets.dataset.save_arguments = editing_save_arguments
		}

	// button save preset
		const button_save_preset = self.button_save_preset
		if (button_save_preset) {

			if (state==='changed' && self.user_preset_section_id) {
				// Show save preset button
				button_save_preset.classList.remove('hide')
			}else{
				// Hide save preset button
				if (!button_save_preset.classList.contains('hide')) {
					button_save_preset.classList.add('hide')
				}
			}
		}

	// save temp preset if changed
		if (state==='changed') {
			// Save temp preset
			await save_temp_preset(self)
		}


	return true
}//end update_state



// SEARCH
	/**
	* EXEC_SEARCH
	* Parses the current search DOM filter into a JSON query object and updates
	* the caller instance (section or area) to execute the search.
	* Includes race condition prevention via `self.searching` flag.
	* Resets order and pagination offset (for sections) before dispatching.
	*
	* The `self.searching` flag prevents re-entrant calls that could result in
	* duplicate concurrent navigations.  It is set to `true` at the start and
	* cleared in a `finally` block so it resets even on error.
	*
	* `caller.search_tipos` is cleared before navigation so that any URL-derived
	* ontology type restriction from the previous search does not persist; the
	* new filter replaces it entirely.
	*
	* @returns {Promise<boolean|Object>} Resolves to `false` if already searching
	*   or on error; otherwise returns the promise from `update_caller`.
	*/
	search.prototype.exec_search = async function() {

		const self = this

		// race condition prevention - return if already searching
		if (self.searching===true) {
			return false
		}
		self.searching = true

		try {

			// section || area thesaurus
			const caller = self.caller

			// caller null check
			if (!caller) {
				console.error('Error: caller is not defined');
				return false
			}

			// source search_action (after caller check to avoid mutation on null caller)
			self.source.search_action = 'search'

			// Delete caller search_tipos (Ontology feature).
			// This allow to re-create the RQO clean on build the caller again ignoring the URL search_tipos value.
			if (caller.search_tipos) {
				caller.search_tipos = null
			}

			// json_query_obj. Recalculate json_query_obj from DOM in default mode (include components with empty values)
			const json_query_obj = self.parse_dom_to_json_filter({
				mode : 'search'
			})

			// reset order
			json_query_obj.order = []

			// pagination reset for section
			if (caller.model === 'section') {
				json_query_obj.offset = 0
			}

		// semantic resolution (RAG, 2026-07-22): resolve-once-then-pin. The ranked
		// hits become filter_by_locators pins + the locator_position order mode, so
		// the normal list renders/pages them in score order and the pins COMPOSE
		// (AND) with the structured filter above.
			// CAPABILITY FIRST (cached probe, the same one the toolbar input's reveal
			// gate makes, asked of the WHOLE scope). The input is hidden where no
			// target section is semantic-searchable, but a SAVED PRESET can still
			// carry a semantic query into an install that never implemented RAG.
			// That is a dead field, not a failure: drop it silently — no request
			// (which would decline and paint a red toast nobody asked for), no
			// status flag, no chip. A stale flag from an earlier failure is also
			// cleared here: this search supersedes it.
			if (self.semantic.q && self.semantic.q.trim()!=='') {
				if (self.caller?.model==='section') {
					self.caller.semantic_status = null
				}
				if (!(await has_embed_groups(self.target_section_tipo))) {
					self.semantic.q = ''
				}
			}

			let filter_by_locators = null
			if (self.semantic.q && self.semantic.q.trim()!=='') {
				const hits = await self.resolve_semantic_hits()
				if (Array.isArray(hits) && hits.length>0) {
					filter_by_locators = hits.map(hit => ({
						section_tipo	: hit.section_tipo,
						section_id		: hit.section_id
					}))
					json_query_obj.order = [{ mode : 'locator_position' }]
					self.semantic.pinned = true
				} else if (Array.isArray(hits)) {
					// zero hits: an EMPTY array means NO pin server-side → sentinel
					// pin yields an honest empty list (no record has id < 1)
					filter_by_locators = [{
						section_tipo	: self.target_section_tipo[0] || self.target_section_tipo,
						section_id		: -1
					}]
					self.semantic.pinned = true
				} else {
					// API error/RAG unavailable → proceed unpinned, flag visibly
					console.warn('[exec_search] semantic search unavailable — searching without it');
					self.semantic.pinned = false
					if (self.caller?.model==='section') {
						self.caller.semantic_status = 'unavailable'
					}
				}
			} else {
				self.semantic.pinned = false
			}

			const js_promise = await update_caller(
				caller,
				json_query_obj,
				filter_by_locators,
				self
			)

			return js_promise

		} catch (error) {
			console.error('Error on exec_search:', error);
			return false
		} finally {
			self.searching = false
		}
	}//end exec_search



	/**
	* RESOLVE_SEMANTIC_HITS
	* Calls dd_rag_api semantic_search with the instance's semantic state and the
	* searched section as scope. Returns the ranked hits array, or false on any
	* API/transport error (the caller proceeds unpinned and flags the status).
	* Results are ACL-gated server-side; limit is clamped server-side to [1,50].
	*
	* `false` means ONE thing here — the call failed. The "this install has no
	* semantic search" case never reaches this function: exec_search asks the
	* capability probe first (has_embed_groups) and drops the query instead.
	*
	* @returns {Promise<Array|false>}
	*/
	search.prototype.resolve_semantic_hits = async function() {

		const self = this

		try {
			const options = {
				query			: self.semantic.q.trim(),
				section_tipo	: Array.isArray(self.target_section_tipo)
					? self.target_section_tipo
					: [self.target_section_tipo],
				limit			: 10
			}
			if (self.semantic.group) {
				options.group = self.semantic.group
			}
			const api_response = await data_manager.request({
				use_worker	: false,
				body		: {
					dd_api			: 'dd_rag_api',
					action			: 'semantic_search',
					prevent_lock	: true,
					options			: options
				}
			})
			const hits = response_data(api_response)
			return Array.isArray(hits)
				? hits
				: false
		} catch (error) {
			console.error('Error on resolve_semantic_hits:', error);
			return false
		}
	}//end resolve_semantic_hits



	/**
	* EXEC_SEMANTIC_SEARCH
	* Quick-input entry point (list toolbar): stores the query on the instance
	* state and fires the normal exec_search pipeline (which resolves the hits,
	* pins them and refreshes the caller). Safe with an unbuilt panel — the
	* structured filter composes from the restored json_filter (see exec_search).
	*
	* @param {string} q - The natural-language query ('' clears the pin).
	* @returns {Promise<boolean|Object>}
	*/
	search.prototype.exec_semantic_search = async function(q) {

		const self = this

		self.semantic.q = typeof q==='string' ? q : ''

		return self.exec_search()
	}//end exec_semantic_search



	/**
	* SHOW_ALL
	* Resets the search filter and updates the caller to show all records.
	*
	* Sends an empty `{$and:[]}` filter and an empty `order` array so the caller
	* displays its full unfiltered record set.  Pagination offset is reset to 0
	* for section callers.  A CSS `loading` class is toggled on the button node
	* to provide visual feedback while the navigation request is in flight.
	*
	* @param {HTMLElement} button_node - The button element that triggered the action.
	* @returns {Promise<*>} Resolves with the result of `update_caller`.
	*/
	search.prototype.show_all = async function(button_node) {

		const self = this

		button_node.classList.add('loading')

		// semantic reset — show_all also unpins any semantic result set
		self.semantic.q			= ''
		self.semantic.pinned	= false

		// source search_action
		self.source.search_action = 'show_all'

		// json_query_obj
		const json_query_obj = {
			filter	: {$and:[]}, // reset filter
			order	: [] // reset order
		}

		// pagination
		if(self.caller?.model === 'section') {
			json_query_obj.offset = 0
		}

		// update_caller
		const js_promise = await update_caller(
			self.caller, // section_instance || area_thesaurus_instance,
			json_query_obj, // json_query_obj
			null, // filter_by_locators,
			self
		)

		button_node.classList.remove('loading')


		return js_promise
	}//end show_all



	/**
	* UPDATE_CALLER
	* Modifies the caller instance's SQO (Search Query Object) and triggers
	* navigation to execute the search.
	*
	* This is the final step in the search dispatch pipeline.  It:
	*  1. Writes all SQO fields (limit, offset, filter, order, filter_by_locators,
	*     children_recursive, section_tipo) back to `caller_instance.rqo.sqo`
	*     and mirrors limit/offset into `caller_instance.request_config_object.sqo`
	*     so both the RQO and the request-config layer are consistent.
	*  2. For section callers: also resets the opposite-mode (list vs edit) local DB
	*     pagination offset to 0 so a stale offset from the other mode is not applied
	*     on the next navigation in that mode.
	*  3. Dispatches navigation via `caller_instance.navigate()`:
	*     - `area_thesaurus` / `area_ontology`: `navigation_history:false`, `action:'search'`.
	*     - `section`: `navigation_history:true`, `action:'search'` (adds a browser history entry).
	*
	* The function is module-private (not assigned to the prototype) because it is
	* a pure utility for `exec_search` and `show_all`; callers outside this module
	* should never call it directly.
	*
	* @param {Object}     caller_instance       - The section or area instance to update.
	* @param {Object}     json_query_obj        - The search configuration object from `parse_dom_to_json_filter`.
	* @param {Array|null} filter_by_locators    - Optional locator-based filter; null to clear.
	* @param {Object}     self                  - The owning `search` instance (for context/state).
	* @returns {Promise<*>} Resolves with the return value of `caller_instance.navigate()`,
	*   or `Promise.resolve(false)` for unknown caller models.
	*/
	const update_caller = async function(caller_instance, json_query_obj, filter_by_locators, self) {

		// short vars with fallback values
			const limit = json_query_obj.limit || (self.limit && self.limit>0 ? self.limit : 10)
			const offset = json_query_obj.offset || 0
			const order = json_query_obj.order || []
			const filter = json_query_obj.filter || null
			const children_recursive = json_query_obj.children_recursive ?? false

		// rqo.sqo update
			caller_instance.total						= null
			caller_instance.rqo.sqo.limit				= limit
			caller_instance.rqo.sqo.offset				= offset
			caller_instance.rqo.sqo.filter				= filter
			caller_instance.rqo.sqo.order				= order
			caller_instance.rqo.sqo.filter_by_locators	= filter_by_locators
			caller_instance.rqo.sqo.children_recursive	= children_recursive
			caller_instance.rqo.sqo.section_tipo		= self.target_section_tipo

		// check valid sections
			if (!self.target_section_tipo || !self.target_section_tipo.length) {
				console.error('Empty target_section_tipo. Unable to update caller:', self.target_section_tipo);
				return
			}

		// request_config_object.sqo update. Copy rqo.sqo pagination values to request_config_object
			caller_instance.request_config_object.sqo.limit		= caller_instance.rqo.sqo.limit
			caller_instance.request_config_object.sqo.offset	= caller_instance.rqo.sqo.offset

		switch (caller_instance.model) {
			case 'area_thesaurus':
			case 'area_ontology': {

				// area. refresh current area using navigation
				const area_ts_promise = caller_instance.navigate({
					callback			: null,
					navigation_history	: false,
					action				: 'search'
				})

				return area_ts_promise
			}

			case 'section': {

				// paginator_node (could exist or not --area_thesaurus case--)
				const paginator_node = caller_instance?.paginator?.node || null
				if (paginator_node) {
					paginator_node.classList.add('loading')
				}

				// pagination. Reset opposite-mode local DB offset values so stale offsets are not reused
				const opposite_mode = caller_instance.mode === 'edit' ? 'list' : 'edit'
				const opposite_pagination_id = `${self.section_tipo}_${opposite_mode}`
				const saved_pagination = await data_manager.get_local_db_data(
					opposite_pagination_id,
					'pagination'
				);
				if (saved_pagination?.value) {
					// reset offset so next navigation for that mode starts at page 0
					saved_pagination.value.offset = 0
					saved_pagination.id = saved_pagination.id || opposite_pagination_id
					await data_manager.set_local_db_data(saved_pagination, 'pagination')
				}

				// section. refresh current section and set history navigation
				const section_promise = caller_instance.navigate({
					callback			: null,
					navigation_history	: true,
					action				: 'search'
				})
				section_promise.finally(()=>{
					// loading css remove
					if (paginator_node) {
						paginator_node.classList.remove('loading')
					}
				})

				return section_promise
			}

			default:

				return Promise.resolve(false)
		}
	}//end update_caller



/**
* TRACK_SHOW_PANEL
* Persists the open/closed state of a named search UI panel to the local IndexedDB.
*
* All panels share the same key (`self.panels_status_id === 'search'`) so the
* preferences are global across sections.  The record value is a plain object
* keyed by panel name, each entry holding `{ is_open: boolean }`.
*
* The local DB record is read, the relevant panel entry is updated, and the
* record is written back.  The write is not awaited at the call site (fire-and-
* forget) because panel state persistence is non-critical.
*
* @param {Object} options
* @param {string} options.name   - Panel identifier string (e.g. 'search_panel').
* @param {string} options.action - 'open' to record as open; any other value records as closed.
* @returns {Promise<boolean>} Resolves to `true` after the write is dispatched.
*/
search.prototype.track_show_panel = async function(options) {

	const self = this

	// options
		const name		= options.name
		const action	= options.action

	const saved_search_state = await data_manager.get_local_db_data(
		self.panels_status_id,
		'context'
	)
	const value = saved_search_state
		? saved_search_state.value
		: {}

	// update value
		value[name] = {
			is_open : (action==='open')
		}

	// local_db_data save
		const data = {
			id		: self.panels_status_id,
			value	: value
		}
		await data_manager.set_local_db_data(
			data,
			'context'
		)


	return true
}//end track_show_panel



/**
* GET_PANELS_STATUS
* Retrieves the persisted open/closed panel state object from the local IndexedDB.
*
* Returns the full record value so the caller can inspect individual panel states
* (e.g. `panels_status.value['search_panel'].is_open`).  Returns `undefined` if
* no record exists yet (first session, or cleared storage).
*
* @returns {Promise<Object|undefined>} The local DB record, or undefined if not found.
*/
search.prototype.get_panels_status = async function() {

	const self = this

	// local_db_data. get value if exists
		const panels_status = await data_manager.get_local_db_data(
			self.panels_status_id,
			'context'
		)

	return panels_status
}//end get_panels_status



/**
* COOKIE_TRACK
* Check if cookie value for this section is true/false
* @return bool
*/
	// search.prototype.cookie_track = async function(name) {

	// 	const self = this

	// 	const section_tipo = self.section_tipo // search.prototype.section_tipo


	// 	// // Read cookie to auto open search_panel
	// 	// const cookie_obj 	= JSON.parse( read_cookie("search") || '{"'+section_tipo+'":{}}' )
	// 	// const cookie_track 	= (cookie_obj[section_tipo]) ? cookie_obj[section_tipo][name] : false

	// // local_db_data. get value if exists
	// 	const saved_search_state = await data_manager.get_local_db_data(
	// 		self.id,
	// 		'context'
	// 	)

	// 		const cookie_track = saved_search_state
	// 			? ((saved_search_state.value[name] && saved_search_state.value[name].is_open) || false)
	// 			: false

	// 	console.log("cookie_track is open:",name,cookie_track);
	// 	return cookie_track
	// }//end cookie_track



/**
* SEARCH_FROM_ENTER_KEY
* @return bool
*/
	// search.prototype.search_from_enter_key = function(button_submit) {

	// 	if(SHOW_DEBUG===true) {
	// 		//console.log("[saerch2.search_from_enter_key] search_panel_is_open:",button_submit, search2.search_panel_is_open);
	// 	}

	// 	// button_submit.click()

	// 	if (search.search_panel_is_open===true) {
	// 		button_submit.click()
	// 	}else{
	// 		this.toggle_search_panel()
	// 	}

	// 	return true
	// }//end search_from_enter_key



/**
* RESET
* Clears all search component values in the current filter and re-renders them.
*
* Iterates `self.ar_instances` in reverse so that any instance that removes
* itself from the array during its `refresh()` call does not disturb the
* remaining indices (defensive iteration order).
*
* For each instance:
*  - `data.entries` is cleared to `[]` — this is THE search value store:
*    `get_component_instance` injects the value there and
*    `serialize_filter_model` reads it back (directly, or through the
*    component's own `get_search_value()`, which also reads `data.entries`).
*    The former `data.value` clearing was a silent no-op: search component
*    instances never carry a `value` key, so the whole reset did nothing.
*  - `data.q_operator` and `data.q_lang` are set to `null` (unconditionally —
*    the old truthiness guards skipped falsy-but-set values).
*  - `refresh({ build_autoload: false })` re-renders the component without
*    triggering a new server data load.
*  - The `hilite_element` "this field has a value" mark (added by the
*    `change_search_element` handler) is removed: it lives on the component
*    WRAPPER, which a 'content' level refresh does not repaint.
*
* After all instances refresh, the cleared filter is persisted as the new
* temp preset so the server state matches the cleared UI state (save_preset
* re-serialises live from the model, so it stores the emptied filter), and
* the in-memory `json_filter` is re-synced from the same serialisation so a
* re-render of the panel cannot resurrect the old values.
*
* Only the FORM is reset — the record list keeps its current results until the
* user runs a search (Apply) or Show all.
*
* @returns {Promise<boolean>} Resolves to `true` when all instances have refreshed.
*/
search.prototype.reset = async function () {

	const self = this

	// reset_instance. A plain async function, NOT `new Promise(async …)`: an
	// async executor's rejection reaches nobody, so a throwing refresh left the
	// executor's resolve() unreached and the whole reset hanging forever. As an
	// async function the throw rejects Promise.all and the caller sees it.
	const reset_instance = async function(instance) {
		if (!instance.data) {
			instance.data = {}
		}
		instance.data.entries		= []
		instance.data.q_operator	= null
		instance.data.q_lang		= null
		// refresh component without load DB data
		await instance.refresh({
			build_autoload : false
		})
		// remove the 'has value' highlight (wrapper class, not repainted by refresh)
		ui.hilite({
			instance	: instance, // instance object
			hilite		: false // bool
		})
		return instance
	}

	const ar_promises			= []
	const ar_instances_length	= self.ar_instances.length
	for (let i = ar_instances_length - 1; i >= 0; i--) {
		ar_promises.push(reset_instance(self.ar_instances[i]))
	}
	await Promise.all(ar_promises)

	// save_temp_preset. Temp preset section_id and section_tipo are solved and fixed on the first load
	const saved = await save_temp_preset(self)

	// json_filter. Re-sync the in-memory filter with what was just persisted.
	// save_preset re-serialises live from the model (structure kept, values now
	// empty) and caches the stored entry in component_json_data.entries[0], so
	// reuse THAT — it already carries the {id, value} entry shape render_filter
	// expects (it reads editing_preset.value). Skipping this would let a panel
	// re-render rebuild the cleared components with their old values.
	if (saved && self.component_json_data?.entries?.[0]) {
		self.json_filter = self.component_json_data.entries[0]
	}

	return true
}//end reset



// @license-end
