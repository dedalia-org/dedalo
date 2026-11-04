// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEBUG, page_globals, DEDALO_CORE_URL, get_label */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {a11y} from '../../common/js/a11y.js'
	import {common} from '../../common/js/common.js'
	import {
		get_instance,
		add_instance,
		delete_instance,
		get_instance_by_id,
		get_all_instances,
		get_instances_custom_map
	} from '../../common/js/instances.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback, when_in_dom} from '../../common/js/events.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {render_edit_ts_object} from './render_edit_ts_object.js'
	import {render_children, reveal_child} from './view_default_edit_ts_object.js'
	import {ApiError, CLIENT_ERROR, request_failed, response_data} from '../../common/js/api_error.js'
	import {handle_api_error} from '../../common/js/error_dispatch.js'
	import {error_text, render_build_failure} from '../../common/js/render_api_error.js'
	import {request_complete} from '../../common/js/sqo_limit.js'



/**
* TS_OBJECT
* Model for a single node (term) in the Dédalo thesaurus or ontology tree.
*
* Each ts_object instance owns one entry in the global instance map and,
* after render(), one DOM wrapper (.wrap_ts_object). The same physical
* section_id can appear under different parents (e.g. relation mode vs.
* tree mode); ts_parent is therefore included in the cache key so that each
* visual placement owns a distinct instance and DOM node.
*
* Core lifecycle:
*   ts_object.get_instance(options) → init() → build() → render()
*
* Key responsibilities:
* - Expand/collapse children branches (set_open, sync_open_dom).
* - Load node data and children data from the PHP API (dd_ts_api).
* - Mutate the local tree in response to add/remove/drag-drop operations
*   without a full server round-trip (add_children_item, remove_children_item,
*   swap_parent).
* - Persist the expand state per node in the client-side local DB ('status').
* - Display component data inline via show_component_in_ts_object and
*   indexation grids via show_indexations.
* - Drive search result rendering through the four-phase parse_search_result
*   pipeline (build → hierarchize → open → hilite).
*
* Prototype methods are mixed in from:
*   common.prototype  – render, refresh, destroy
*   render_edit_ts_object.prototype – edit, search
*   view_default_edit_ts_object – render_children
*
* Globals consumed: SHOW_DEBUG, page_globals, DEDALO_CORE_URL
*
* @exports ts_object
* @exports key_instances_builder
*/
export const ts_object = function() {

	// string id. Cache key for the global instance map; composed from key_parts (see key_instances_builder).
	this.id
	// string model. Always 'ts_object' — used by instance pool filters.
	this.model
	// string mode. Render mode; 'edit' by default, 'search' during parse_search_result.
	this.mode
	// object|null caller. Pointer to the owning instance: area_thesaurus/area_ontology for root nodes,
	// a ts_object for all others. Used to traverse the tree upward.
	this.caller
	// object linker. Indexation context injected by tool_indexation.
	// Shape: { id: caller_id, caller: indexing_component }
	this.linker

	// string section_tipo. Ontology tipo of this thesaurus section (e.g. 'hierarchy1', 'flora1').
	this.section_tipo
	// string|int section_id. Record identifier within section_tipo.
	// (!) Doc typo in original: says 'section_tipo' — it is in fact section_id.
	this.section_id
	// string children_tipo. Tipo of the component_relation_children component for this section.
	// Kept as a shortcut to avoid re-reading it from data on every expand.
	// (!) Original comment spelled it 'componetn_children' — corrected here.
	this.children_tipo
	// string target_section_tipo. Tipo of the target section for the current item.
	// (!) Intentionally commented-out in both the constructor and init(); kept for future use.
		// this.target_section_tipo
	// bool is_root_node. True for nodes attached directly to an area (no parent ts_object).
	// Root nodes are linked via a portal in the hierarchy section, not via component_relation_parent.
	this.is_root_node
	// int virtual_order. Client-side display order within the parent's children list.
	// Derived from the 'order' field in server data and the position in the rendered sibling array.
	this.virtual_order

	// object data. Raw term data returned by get_node_data / injected via build().
	// Shape mirrors a row from dd_ts_api::get_node_data result:
	//   { ar_elements, ts_id, ts_parent, is_descriptor, order, permissions_*, ... }
	this.data
	// object children_data. Cached result of get_children_data.
	// Shape: {
	//   ar_children_data : [ { section_tipo, section_id, ts_id, ar_elements, ... }, ... ],
	//   pagination       : { limit: 300, offset: 0, total: 2 }
	// }
	this.children_data

	// string ts_id. Compact node identifier: section_tipo + '_' + section_id (e.g. 'hierarchy1_66').
	// Used as the key for parent/child relationships in the in-memory tree.
	this.ts_id
	// string ts_parent. ts_id of the parent node (e.g. 'hierarchy1_1').
	// 'root' when the node is a top-level child of the area. Part of the cache key (see key_order).
	this.ts_parent

	// bool is_descriptor. False for non-descriptor (ND) nodes. Determines arrow/expand availability.
	this.is_descriptor
	// bool is_ontology. True when the owning area is area_ontology; false for area_thesaurus.
	this.is_ontology

	// vars from options
	// HTMLElement|null element_to_hilite. Node scheduled for highlight on the next DOM update (set during refresh).
	this.element_to_hilite
	// string thesaurus_mode. Controls the visual appearance/behavior of the thesaurus tree.
	// Typical values: 'default', 'relation'. Part of the cache key.
	this.thesaurus_mode
	// string thesaurus_view_mode. Values: 'model' | 'default'.
	// When 'model', term labels are drawn from the ontology model rather than data entries.
	this.thesaurus_view_mode
	// Array events_tokens. Holds event_manager subscription tokens so they can be unsubscribed on destroy.
	this.events_tokens = []
	// bool is_open. Whether children are currently visible. Single source of truth; DOM is a projection.
	this.is_open = false
	// string status. Lifecycle state: 'initializing' → 'initialized' → 'building' → 'built'.
	this.status
	// Array ar_instances. Child ts_object instances owned by this node; used by destroy() cascade.
	this.ar_instances = []
	// Promise|null children_request. In-flight get_children_data request used for deduplication.
	// A rapid double-click on the expand arrow joins this promise instead of firing a new one.
	this.children_request = null
	// string|null children_request_signature. JSON signature of the in-flight request options.
	// Compared to the incoming request; mismatch forces a new request.
	this.children_request_signature = null

	// int permissions_button_delete. Delete permission level for this node. Values: 0 (none) – 3 (full).
	this.permissions_button_delete
	// int permissions_button_new. Create-child permission level. Values: 0 (none) – 3 (full).
	this.permissions_button_new
	// int permissions_indexation. Indexation permission level. Values: 0 (none) – 3 (full).
	this.permissions_indexation

	// bool has_descriptor_children. True when this node has at least one descriptor child.
	// Controls whether the expand arrow is rendered.
	this.has_descriptor_children
	// string area_model. Model identifier of the containing area: 'area_thesaurus' or 'area_ontology'.
	this.area_model

	// HTMLElement node. The root wrapper DOM element (.wrap_ts_object). Set by render_wrapper.
	this.node
	// HTMLElement children_container. Holds the rendered child ts_object nodes (.children_container).
	this.children_container
	// HTMLElement link_children_element. The clickable expand/collapse arrow button.
	this.link_children_element
	// HTMLElement term_node. The clickable term label node (.term). Used for highlighting.
	this.term_node
	// HTMLElement term_text. Text span inside term_node that holds the visible label string.
	this.term_text
	// HTMLElement data_container. Container for inline component editors (show_component_in_ts_object).
	this.data_container
	// int show_component_seq. Monotonic token for overlapping show_component_in_ts_object
	// calls (rapid clicking): only the newest may mutate data_container.
	this.show_component_seq = 0
	// HTMLElement indexations_container. Container for the indexation dd_grid (show_indexations).
	this.indexations_container
	// HTMLElement nd_container. Container shown/hidden by toggle_nd for non-descriptor children.
	this.nd_container
}//end ts_object



/**
* COMMON FUNCTIONS
* Extend ts_object with shared lifecycle and render methods from common and
* the specialized render modules. Individual prototype assignments are not
* separately doc-blocked; documentation lives at the source definition.
*/
// prototypes assign
	ts_object.prototype.render	= common.prototype.render
	ts_object.prototype.refresh	= common.prototype.refresh
	// destroy — the children row window (view_default_edit_ts_object
	// render_children) holds the viewport observer over rows that are this
	// node's dependencies. Signature MIRRORS common.prototype.destroy.
	ts_object.prototype.destroy	= async function(delete_self=true, delete_dependencies=false, remove_dom=false) {
		const self = this
		if (self.row_window && (delete_self || delete_dependencies)) {
			self.row_window.destroy()
		}
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}

	// render
	ts_object.prototype.edit			= render_edit_ts_object.prototype.edit
	// search mode intentionally reuses the edit render — same DOM, different mode flag
	ts_object.prototype.search			= render_edit_ts_object.prototype.edit
	ts_object.prototype.render_children	= render_children
	ts_object.prototype.reveal_child	= reveal_child



/**
* KEY_ORDER
* Ordered list of option property names used by key_instances_builder to
* compose the unique instance cache key. Only non-empty values are included.
* ts_parent is last: it differentiates the same term rendered under two
* different parents (e.g. tree vs. relation-list view).
*/
const key_order = ['section_tipo','section_id','children_tipo','target_section_tipo','thesaurus_mode','ts_parent']



/**
* GET_INSTANCE
* Factory / singleton accessor for ts_object instances.
* Builds a normalized cache key from options, returns the cached instance
* when one exists, or creates, initializes, caches, and returns a new one.
* Callers should always use this method rather than constructing ts_object
* directly to guarantee key consistency and single-ownership of DOM nodes.
* @param {Object} options - Property bag forwarded to init(); must include at
*   minimum section_tipo and section_id. See key_order for key-part properties.
* @returns {Promise<Object>} The ts_object instance (new or cached).
*/
ts_object.get_instance = async function (options) {

	const key = key_instances_builder(options)

	// search. Check if the instance is already in the cache
	const found_instance = get_instance_by_id(key)
	if (found_instance) {
		return found_instance;
	}

	// Get the ts_object instance
	const instance_element = new ts_object()

	// id
	instance_element.id = key

	// Init the new instance
	await instance_element.init(options)

	// Cache instance
	add_instance(key, instance_element)


	return instance_element
}//end get_instance



/**
* KEY_INSTANCES_BUILDER
* Builds a normalized underscore-delimited string key from selected
* properties of the options object. The key uniquely identifies a ts_object
* instance in the global instance map. Properties are taken from key_order;
* undefined, null, and empty-string values are skipped.
*
* Exported so that external callers (e.g. drag_and_drop.js, area_thesaurus)
* can compute the same key without holding an instance reference.
*
* @param {Object} options - Source object; only key_order properties are read.
* @param {string} [options.section_tipo] - e.g. 'hierarchy1', 'flora1'
* @param {string|number} [options.section_id] - e.g. 1 or '45'
* @param {string} [options.children_tipo] - e.g. 'hierarchy49'
* @param {string} [options.target_section_tipo] - Target section tipo (rarely set).
* @param {string} [options.thesaurus_mode] - e.g. 'default', 'relation'
* @param {string} [options.ts_parent] - e.g. 'hierarchy1_1' or 'root'
* @returns {string} Prefixed key, e.g. 'ts_object_hierarchy1_66_hierarchy49_root'
*
* @example
* key_instances_builder({ section_tipo: 'hierarchy1', section_id: 1 })
* // → 'ts_object_hierarchy1_1'
*
* @example
* key_instances_builder({
*   section_tipo: 'flora1', section_id: 4,
*   children_tipo: 'hierarchy49', thesaurus_mode: 'default', ts_parent: 'root'
* })
* // → 'ts_object_flora1_4_hierarchy49_default_root'
*
* @example
* // null/undefined/empty values are excluded from the key
* key_instances_builder({ section_tipo: 'hierarchy1', section_id: null, thesaurus_mode: 'model' })
* // → 'ts_object_hierarchy1_model'
*/
export const key_instances_builder = function(options) {

	const key_parts = []

	for (const prop of key_order) {
		const value = options[prop];
		if (value !== undefined && value !== null && value !== '') {
			const string_value = String(value);
			key_parts.push(string_value);
		}
	}

	// join all non empty elements in an string used as ID for the instance
	return 'ts_object_' + key_parts.join('_')
}//end key_instances_builder



/**
* REKEY
* Re-registers the instance in the global instances map after key-part
* changes (e.g. ts_parent updated by swap_parent). Without this, the
* instance stays cached under its old key and a later get_instance for
* the same term under the new parent would create a duplicate while this
* instance still owns the DOM node.
* Note: ts_parent is deliberately part of key_order — one instance owns one
* DOM node, and the same term visible in two contexts (e.g. relation mode
* and tree) must not steal nodes from each other.
* @returns {boolean}
*/
ts_object.prototype.rekey = function() {

	const self = this

	const old_id = self.id

	// new key from current key-part properties
	const new_key = key_instances_builder({
		section_tipo		: self.section_tipo,
		section_id			: self.section_id,
		children_tipo		: self.children_tipo,
		target_section_tipo	: null,
		thesaurus_mode		: self.thesaurus_mode,
		ts_parent			: self.ts_parent
	})
	if (new_key===old_id) {
		return true // nothing to do
	}

	// re-register in the global instances map
	delete_instance(old_id)
	self.id = new_key
	add_instance(new_key, self)

	// sync the DOM dataset id (read by drag and drop on_drop)
	if (self.node?.dataset) {
		self.node.dataset.id = new_key
	}

	// migrate the persisted expand state to the new id
	data_manager.get_local_db_data(old_id, 'status')
	.then((status) => {
		if (status?.value) {
			data_manager.delete_local_db_data(old_id, 'status')
			data_manager.set_local_db_data(
				{ id: new_key, value: status.value },
				'status'
			)
		}
	})

	return true
}//end rekey



/**
* INIT
* Populates all instance properties from the options object.
* Called once by get_instance immediately after construction; not intended
* for direct external calls. Property-to-option mapping is 1:1; see the
* constructor property declarations for type and default documentation.
* Sets self.status = 'initializing' → 'initialized'.
* @param {Object} options - Same property bag as get_instance; all key-part
*   and non-key properties must be supplied by the caller.
* @returns {Promise<boolean>} Always resolves to true.
*/
ts_object.prototype.init = async function(options) {

	const self = this

	// status update
	self.status = 'initializing'

	// string model. Fix 'ts_object' value.
	self.model = 'ts_object'
	// string mode. Default is 'edit'.
	self.mode = options.mode || 'edit'
	// object|null caller. Caller instance pointer. Is area_thesaurus/area_ontology for roots and ts_object for others.
	self.caller	= options.caller
	// object linker. Used for tool indexation
	// E.g.  {
	// 	id		: caller_id,
	// 	caller	: indexing_component
	// }
	self.linker	= options.linker
	// string section_tipo. Current thesaurus item section_tipo
	self.section_tipo = options.section_tipo
	// string|int section_id. Current thesaurus item section_tipo
	self.section_id = options.section_id
	// string children_tipo. Tipo of the componetn_children for current section (for easy access)
	self.children_tipo = options.children_tipo
	// string target_section_tipo. Tipo of the target section for current item.
		// self.target_section_tipo = options.target_section_tipo
	// bool is_root_node. Identifies the area_thesaurus/area_ontology direct 'children'
	// This elements do not have 'parent', they are linked by a portal in hierarchy section.
	self.is_root_node = options.is_root_node
	// int virtual_order. Initial assignment from options (overridden again below with || null guard).
	// (!) virtual_order is assigned twice in this method; the second assignment below supersedes this one.
	self.virtual_order = options.virtual_order
	// object data. Data from current instance (term)
	self.data = options.data
	// object children_data. E.g. {
	//	  ar_children_data : [{ar_elements:[]...}],
	//	  pagination : {"limit": 300,"offset": 0,"total": 2}
	// }
	self.children_data = options.children_data
	// string ts_id. Node contraction of section_tipo + section_id as tipo like 'dd256'
	self.ts_id = options.ts_id
	// string ts_parent. Parent contraction of section_tipo + section_id as tipo like 'dd98'
	self.ts_parent = options.ts_parent

	// bool is_ontology. If caller model is 'area_ontology' is true, false otherwise.
	self.is_ontology = options.is_ontology
	// string thesaurus_mode. Special thesaurus mode from properties. Default is 'default'
	self.thesaurus_mode = options.thesaurus_mode
	// string thesaurus_view_mode. Values: model|default
	self.thesaurus_view_mode = options.thesaurus_view_mode
	// int permissions_button_delete. Values from 0,1,2,3
	self.permissions_button_delete = options.permissions_button_delete
	// int permissions_button_new. Values from 0,1,2,3
	self.permissions_button_new	= options.permissions_button_new
	// int permissions_indexation. Values from 0,1,2,3
	self.permissions_indexation	= options.permissions_indexation
	// string area_model. Model of current thesaurus/ontology area
	self.area_model = options.area_model
	// int order. Order value from ts data
	self.order = options.order ?? null

	// virtual order. Normalizes falsy values to null (|| null replaces the earlier assignment above).
	self.virtual_order = options.virtual_order || null

	// status update
	self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Loads node data from the server (unless already present) and syncs
* derived properties (permissions, ts_id, ts_parent, order, etc.) from the
* returned data object onto the instance.
* Called after init() and before render(). Follows the same call-site
* pattern as component_common.build() for API uniformity.
* (!) For component instances (not ts_object), always use component_common.build().
* @param {boolean} [autoload=false] - When true, forces a fresh server fetch
*   even if self.data is already populated (used after structural mutations).
* @returns {Promise<boolean>} Always resolves to true.
*/
ts_object.prototype.build = async function(autoload=false) {

	const self = this

	// status update
		self.status = 'building'

	// load node data from database
		if (!self.data || autoload===true) {

			// Get and fix
			self.data = await self.get_node_data()
		}

	// fix vars from data
		if (self.data) {
			// fix permissions
			self.permissions_button_new		= self.data.permissions_button_new
			self.permissions_button_delete	= self.data.permissions_button_delete
			self.permissions_indexation		= self.data.permissions_indexation

			self.is_descriptor				= self.data.is_descriptor
			self.is_indexable				= self.data.is_indexable

			self.ts_id						= self.data.ts_id || self.ts_id
			self.ts_parent					= self.data.ts_parent || self.ts_parent
			self.order						= self.data.order
			self.has_descriptor_children	= self.data.has_descriptor_children
		}

	// status update
		self.status = 'built'


	return true
}//end common.prototype.build



/**
* GET_NODE_DATA
* Fetches the full data object for this term from the PHP API (dd_ts_api,
* action: 'get_node_data'). The result is stored in self.data by build().
* Derives thesaurus_view_mode and terms_are_model from the caller instance
* so the server can tailor the response (e.g. ontology model labels).
* @returns {Promise<Object>} Resolves to the API response payload on success.
*   Result shape: { ar_elements, ts_id, ts_parent, is_descriptor, order,
*     permissions_button_new, permissions_button_delete, permissions_indexation,
*     has_descriptor_children, ... }
* @throws {Error} Re-throws with extended context (section_tipo, section_id)
*   on network failure or when the API returns no result.
*/
ts_object.prototype.get_node_data = async function() {

	const self = this

	// short vars
		const caller				= self.caller
		const thesaurus_view_mode	= caller?.thesaurus_view_mode
		const terms_are_model		= thesaurus_view_mode==='model'
		const section_tipo			= self.section_tipo
		const section_id			= self.section_id
		const children_tipo			= self.children_tipo

	try {

		// API call
		const rqo = {
			dd_api			: 'dd_ts_api',
			prevent_lock	: true,
			action			: 'get_node_data',
			source			: {
				section_id		: section_id,
				section_tipo	: section_tipo,
				children_tipo	: children_tipo,
				area_model		: self.area_model,
				build_options	: {
					terms_are_model : terms_are_model
				}
			},
			options : {
				thesaurus_view_mode	: thesaurus_view_mode
			}
		}
		// picker caller (get_picker_caller): only set when the tree is a picker
		const picker_caller = get_picker_caller(self)
		if (picker_caller) {
			rqo.source.caller = picker_caller
		}

		const api_response = await data_manager.request({
			use_worker	: false,
			body		: rqo
		})
		// debug
		if(SHOW_DEBUG===true) {
			console.log('get_node_data api_response:', api_response);
		}

		// Validate response structure
		if (!api_response || typeof api_response !== 'object') {
			throw new Error("Invalid API response format");
		}

		const node_data = response_data(api_response)
		if (node_data) {

			// success case

			return node_data

		}else{

			// error case

			console.warn("[get_node_data] Error, the API response carries no data");
			throw new Error("API response did not contain a valid result.");
		}
	} catch (error) {
		// Catch network errors or explicit throws
		console.error("[get_node_data] API request failed:", error);
		// Propagate the error by re-throwing or rejecting the promise
		const custom_error = new Error(`get_node_data failed for section_tipo: ${section_tipo}, section_id: ${section_id} - ${error.message}`);
		custom_error.originalError = error;
		custom_error.context = { section_tipo, section_id };
		throw custom_error;
	}
}//end get_node_data



/**
* GET_PICKER_CALLER
* The tree PICKER's caller declaration this node was opened for — the owning
* area's `picker_caller` (`{section_tipo, section_id, tipo, callers}`, set by
* component_portal build_thesaurus_pane), found up the `.caller` chain (a node's
* caller is its parent node, a root node's is the area). Cycle-safe.
* The node reads send it as `source.caller`: a user who can WRITE the picker
* component browses its target thesaurus read-only through it, even without a
* grant on the thesaurus (owner decision (i) — server: ts_object/ts_api.ts
* requireTreeReadLevel). An ordinary browse tree has none → null, and the reads
* keep their exact previous shape.
* @param {Object} self - The ts_object instance
* @returns {Object|null}
*/
export const get_picker_caller = function(self) {

	const visited = new Set()
	let current = self ? self.caller : null
	while (current && !visited.has(current)) {
		visited.add(current)
		if (current.picker_caller) {
			return current.picker_caller
		}
		if (typeof current.model==='string' && current.model.startsWith('area_')) {
			return null
		}
		current = current.caller
	}


	return null
}//end get_picker_caller



/**
* GET_CHILDREN_DATA
* Fetches the immediate children of this node from the PHP API
* (dd_ts_api, action: 'get_children_data').
* Two short-circuit paths exist before hitting the server:
*   1. Cache hit: if cache=true and self.children_data is populated, returns it.
*   2. In-flight dedup: identical concurrent calls share the running Promise.
* The returned ar_children_data array is sorted by the 'order' field (ascending)
* before resolving. Callers are responsible for storing the result on self.children_data
* when they want it cached for subsequent opens.
* @param {Object} options
* @param {Object|null} [options.pagination=null] - Pagination params forwarded to the API.
* @param {Array|null} [options.children=null] - Explicit child locator list; null = all.
* @param {boolean} [options.cache=true] - Return self.children_data when available.
* @returns {Promise<Object>} Resolves to the API response payload.
*   Shape: { ar_children_data: Array, pagination: { limit, offset, total } }
* @throws {Error} Re-throws on API failure.
*/
ts_object.prototype.get_children_data = async function(options) {

	const self = this

	// options
		const {
			pagination = null,
			children = null,
			cache = true
		} = options;

	// short vars
		const section_id			= self.section_id
		const section_tipo			= self.section_tipo
		const children_tipo			= self.children_tipo
		const caller				= self.caller
		const model					= caller?.model
		const thesaurus_view_mode	= caller?.thesaurus_view_mode
		const terms_are_model		= thesaurus_view_mode==='model'

	// cache
		if (cache && self.children_data) {
			return self.children_data
		}

	// in-flight dedup. A second identical call (rapid double-click on the
	// expand arrow) joins the running request instead of firing a new one.
		const request_signature = JSON.stringify({p: pagination, c: children})
		if (self.children_request && self.children_request_signature===request_signature) {
			return self.children_request
		}

	const request_promise = (async () => {

		try {

			// API call
			const rqo = {
				dd_api			: 'dd_ts_api',
				prevent_lock	: true,
				action			: 'get_children_data',
				source			: {
					section_id		: section_id,
					section_tipo	: section_tipo,
					children_tipo	: children_tipo,
					model			: model,
					children		: children,
					build_options	: {
						terms_are_model : terms_are_model
					}
				},
				options : {
					pagination			: pagination,
					thesaurus_view_mode	: thesaurus_view_mode
				}
			}
			// picker caller (get_picker_caller): only set when the tree is a picker
			const picker_caller = get_picker_caller(self)
			if (picker_caller) {
				rqo.source.caller = picker_caller
			}

			const api_response = await data_manager.request({
				use_worker	: false,
				body		: rqo
			})
			// debug
			if(SHOW_DEBUG===true) {
				console.warn('get_children_data api_response:', api_response);
			}

			const children_data = response_data(api_response)
			if (children_data) {

				// success case

				// Sort by order (ascending)
				children_data.ar_children_data.sort((a, b) => a.order - b.order);

				return children_data

			}else{

				// error case

				console.warn("[get_children_data] Error, the API response carries no data");
				throw new Error("API response did not contain a valid result.");
			}
		} catch (error) {
			// Catch network errors or explicit throws
			console.error("[get_children_data] API request failed:", error);
			// Propagate the error by re-throwing or rejecting the promise
			throw error;
		}
	})()
	.finally(() => {
		// release the in-flight slot (resolved value stays cached in
		// self.children_data by callers when applicable)
		self.children_request = null
		self.children_request_signature = null
	})

	// register in-flight request
		self.children_request = request_promise
		self.children_request_signature = request_signature


	return request_promise
}//end get_children_data



/**
* ADD_CHILDREN_ITEM
* Appends a child data object to self.children_data.ar_children_data and
* updates derived state (has_descriptor_children, is_open). Used after a
* successful swap_parent or drag-drop to keep the in-memory tree consistent
* without a full server round-trip.
* When the first child is added (length becomes 1), forces is_open=true and
* calls sync_open_dom() so the tree opens to reveal the newly added node.
* @param {Object} children_data - A single child row from ar_children_data.
*   Shape: {
*     section_tipo: string,
*     section_id:   string,
*     ts_id:        string,      // e.g. 'flora1_4'
*     ar_elements:  Array,       // term labels and component references
*     children_tipo: string,
*     has_descriptor_children: boolean
*   }
* @returns {boolean} false when children_data is falsy; true on success.
*/
ts_object.prototype.add_children_item = function ( children_data ) {

	if (!children_data) {
		console.error('Invalid children_data provided');
		return false;
	}

	if (!this.children_data) {
		this.children_data = {
			ar_children_data : [],
			pagination : null
		}
	}
	this.children_data.ar_children_data.push( children_data )

	// Update the has_descriptor_children property
	if (this.children_data.ar_children_data.length===1) {
		this.data.has_descriptor_children = this.has_descriptor_children = true
		this.is_open = true // Forces is_open to allow to see the added children in new renders
		this.sync_open_dom()
	}

	return true
}//end add_children_item



/**
* REMOVE_CHILDREN_ITEM
* Removes a child data entry from self.children_data.ar_children_data by ts_id
* match and re-synchronizes derived state. Used after delete_term or a
* successful swap_parent to keep the in-memory tree accurate.
* Side effects when the last child is removed:
*   - Sets has_descriptor_children and self.data.has_descriptor_children to false.
*   - Collapses the node (is_open=false) and calls sync_open_dom().
*   - Clears link_children_element.
* After removal, re-indexes virtual_order (1-based) for remaining descriptor
* siblings using a pre-built Map for O(1) instance lookups.
* @param {Object} children_data - The child row to remove; must have ts_id.
*   Shape matches the add_children_item parameter.
* @returns {boolean} false when children_data/ts_id is missing or not found; true on success.
*/
ts_object.prototype.remove_children_item = function ( children_data ) {

	const self = this

	if (!children_data || !children_data.ts_id) {
		console.error('Invalid children_data provided - missing ts_id');
		return false;
	}

	if (!this.children_data?.ar_children_data) {
		console.error('Current instance do not has children_data');
		return false;
	}

	const index = this.children_data.ar_children_data.findIndex(el => el.ts_id === children_data.ts_id);

	if (index === -1) {
		console.log('Children data not found with ts_id:', children_data.ts_id);
		return false;
	}

	// Remove the element directly
	this.children_data.ar_children_data.splice(index, 1);

	// Update the has_descriptor_children property
	if (this.children_data.ar_children_data.length===0) {
		this.data.has_descriptor_children = this.has_descriptor_children = false
		this.is_open = false
		this.sync_open_dom()
		this.link_children_element = null
	}

	// Update pagination
	if (this.children_data.pagination) {
		this.children_data.pagination.total = this.children_data.ar_children_data.length
	}

	// Update order (descriptors only)
	// After removal, re-calculate sequential order for remaining descriptor children.
	// This ensures consistent ordering (1-based) for all descriptors and syncs
	// the new order values to their corresponding instance objects.
	const children_data_descriptors = (this.children_data.ar_children_data || []).filter(el => el.is_descriptor===true)

	// Build a lookup Map of child instances for O(1) access
	// Key: section_tipo + section_id + children_tipo (unique per child)
	const children_map = get_instances_custom_map(instance => {
		if (instance.model !== 'ts_object' ||
			instance.ts_parent !== self.ts_id ||
			instance.thesaurus_mode !== self.thesaurus_mode) {
			return null // exclude non-relevant instances
		}
		return `${instance.section_tipo}_${instance.section_id}_${instance.children_tipo}`
	})

	children_data_descriptors.forEach((child, index) => {

		// Create a new sequential order (1-based index)
		const virtual_order = index + 1

		// O(1) lookup using the pre-built Map
		const map_key = `${child.section_tipo}_${child.section_id}_${child.children_tipo}`
		const instance = children_map.get(map_key)

		// Sync the new order to the instance (if found)
		if (instance) {
			instance.virtual_order = virtual_order
		}
	})

	return true
}//end remove_children_item



/**
* SET_OPEN
* Single entry point for expand/collapse. Owns the is_open state:
* updates self.is_open synchronously (so concurrent calls observe the
* transition), loads + renders children when needed, projects the state
* to the DOM via sync_open_dom() and persists it.
* @param {boolean} is_open - True to expand; false to collapse.
* @param {Object} [options={}]
* @param {boolean} [options.persist=true] - Persist the state in the local db 'status' table.
* @param {boolean} [options.force_reload=false] - Discard cached children_data and reload from API.
* @returns {Promise<boolean>}
*/
ts_object.prototype.set_open = async function(is_open, options={}) {

	const self = this

	// options
		const {
			persist = true,
			force_reload = false
		} = options

	// children_container. Non descriptor nodes have nothing to open
		if (!self.children_container) {
			return false
		}

	// state first. The flag is the single source of truth; DOM classes are
	// a projection of it (see sync_open_dom)
		self.is_open = is_open

	// load and render children when opening an empty (or force reloaded) container
		if (is_open===true) {

			const must_load = force_reload===true || !self.children_container.hasChildNodes()
			if (must_load) {

				// add loading_spinner style
				if (self.link_children_element) {
					self.link_children_element.classList.add('loading_spinner')
				}

				if (force_reload===true) {
					// Clean children data to force reload
					self.children_data = null
				}

				const children_data = await self.get_children_data({
					pagination	: self.pagination,
					children	: null
				})

				// remove loading_spinner style
				if (self.link_children_element) {
					self.link_children_element.classList.remove('loading_spinner')
				}

				if (!children_data?.ar_children_data) {
					console.error('[ts_object.set_open] Error getting children data. children_data:', children_data);
					self.is_open = false
					self.sync_open_dom()
					return false
				}

				// Fix children_data
				self.children_data = children_data

				// Add children nodes into self.children_container or nd_container
				await self.render_children({
					clean_children_container	: true,
					children_data				: children_data
				})
			}
		}

	// project state to DOM
		self.sync_open_dom()

	// persist. Tracks element open children status in the local db
		if (persist===true) {
			if (is_open===true) {
				data_manager.set_local_db_data(
					{
						id		: self.id,
						value	: 1
					}, // mixed data
					'status' // string table
				)
			}else{
				data_manager.delete_local_db_data(self.id, 'status')
			}
		}


	return true
}//end set_open



/**
* SYNC_OPEN_DOM
* Projects self.is_open onto the DOM: children_container visibility ('hide')
* and expand arrow state ('open'). The ONLY place these classes change.
* @returns {boolean}
*/
ts_object.prototype.sync_open_dom = function() {

	const self = this

	if (self.children_container) {
		if (self.is_open===true) {
			self.children_container.classList.remove('hide')
		}else{
			self.children_container.classList.add('hide')
		}
	}

	if (self.link_children_element) {
		if (self.is_open===true) {
			self.link_children_element.classList.add('open')
		}else{
			self.link_children_element.classList.remove('open')
		}
		// a11y (audit P1-18 / CLI-11). The open state is projected onto the
		// accessibility tree from the SAME single entry point that projects it onto
		// the CSS class — a second place to keep in step is how the two drift.
		a11y.set_expanded(self.link_children_element, self.is_open===true)
	}

	return true
}//end sync_open_dom



/**
* UPDATE_CHILDREN_STATE
* Orchestrates a full or partial children UI refresh after any mutation
* (add, remove, swap, drag-drop). Accepts fine-grained flags so callers
* can skip expensive steps they have already handled (e.g. swap_parent
* passes render:false because it moved the DOM node directly).
* Execution order: fetch → update state → render → refresh content → show.
* @param {Object} [options={}]
* @param {Object|null} [options.children_data=null] - Inject new children data;
*   when null the current self.children_data is used.
* @param {boolean} [options.fetch_data=false] - Fetch fresh data from the
*   server (cache:false) before updating state.
* @param {boolean} [options.render=true] - Re-render the children DOM.
* @param {boolean} [options.refresh_content=true] - Refresh the term line and
*   expand-arrow via self.refresh() at render_level:'content'.
* @param {boolean} [options.show_children=true] - Open the node (is_open=true)
*   when has_descriptor_children is true after the update.
* @param {boolean} [options.clean_container=true] - Clear children_container
*   before re-rendering children.
* @returns {Promise<boolean>} false when a server fetch fails; true otherwise.
*/
ts_object.prototype.update_children_state = async function(options = {}) {

	const self = this

	// Default options
	const {
		children_data = null,
		fetch_data = false,
		render = true,
		refresh_content = true,
		show_children = true,
		clean_container = true
	} = options

	// 1. FETCH DATA (if requested)
	let data = children_data
	if (fetch_data) {
		data = await self.get_children_data({ cache: false })
		if (!data) {
			console.warn('[update_children_state] Failed to fetch children data')
			return false
		}
	}

	// 2. UPDATE INSTANCE STATE
	if (data) {
		self.children_data = data

		// Sync has_descriptor_children with actual data
		const has_children = data.ar_children_data?.length > 0
		self.has_descriptor_children = has_children
		if (self.data) {
			self.data.has_descriptor_children = has_children
		}
	}

	// 3. RENDER CHILDREN (if requested and data exists)
	if (render && self.children_data?.ar_children_data) {
		await self.render_children({
			clean_children_container: clean_container,
			children_data: self.children_data
		})
	}

	// 4. REFRESH CONTENT (updates term line, arrow icon, etc.)
	if (refresh_content) {
		await self.refresh({
			build_autoload: false,
			render_level: 'content',
			destroy: false
		})
	}

	// 5. SHOW CHILDREN (if requested and has children)
	if (show_children && self.has_descriptor_children) {
		self.is_open = true
		requestAnimationFrame(() => {
			self.sync_open_dom()
		})
	}

	return true
}//end update_children_state



/**
* GET_CHILDREN_RECURSIVE
* Returns a flat list of all descendant locators for a given term by
* issuing a section search with children_recursive:true. Used when a
* batch operation needs every descendant (e.g. deletion with cascade).
* (!) Uses the generic section search API (action:'read'), not dd_ts_api,
* with a hardcoded ddo_map:[] — no component data is requested. The read is
* walked at the server's client ceiling (request_complete), never `limit: 0`.
* @param {Object} options
* @param {string} options.section_tipo - Tipo of the root term to recurse from.
* @param {string|number} options.section_id - Record ID of the root term.
* @returns {Promise<Array|boolean>} Array of { section_tipo, section_id }
*   locator objects on success; false on validation failure or API error.
*/
ts_object.prototype.get_children_recursive = async function( options ) {

	// short vars
		const section_tipo	= options.section_tipo
		const section_id	= options.section_id

	// check vars
		if (!section_tipo || typeof section_tipo==="undefined") {
			console.log("[get_children_recursive] Error. section_tipo is not defined");
			return false
		}
		if (!section_id || typeof section_id==="undefined") {
			console.log("[get_children_recursive] Error. section_id is not defined");
			return false
		}

	// API call. A COMPLETENESS read (the whole descendant set): walked page
	// by page at the server's client ceiling through request_complete
	// (common/js/sqo_limit.js) — never one request with `limit: 0`, which the
	// server read as the same ceiling and truncated in silence (audit P2-31 /
	// CLI-30). Each page answers ONE section item whose `value` holds that
	// page's locators; the pages' values are concatenated.
	const rqo = {
		action			: 'read',
		source			: {
			typo			: 'source',
			type			: 'section',
			action			: 'search',
			model			: 'section',
			tipo			: section_tipo,
			section_tipo	: section_tipo,
			section_id		: null,
			mode			: 'list',
			lang			: page_globals.dedalo_data_nolan,
		},
		show : {
			ddo_map : []
		},
		sqo : {
			section_tipo	: [section_tipo],
			filter_by_locators: [{
				section_tipo	: section_tipo,
				section_id		: section_id
			}],
			children_recursive: true
		}
	}
	const complete = await request_complete(rqo, {
		count_rows : (datum) => {
			const item = datum.data.find(el => el.tipo === section_tipo)
			return Array.isArray(item?.value) ? item.value.length : 0
		}
	})
	if (!complete) {
		// error case
		console.warn("[ts_object.get_children] Error, response is null");
		return false
	}

	const children_recursive = complete.data
		.filter(el => el.tipo === section_tipo && Array.isArray(el.value))
		.flatMap(el => el.value)
		.map(el => {
			return {
				section_tipo	: el.section_tipo,
				section_id		: el.section_id
			}
		})


	return children_recursive
}//end get_children_recursive



/**
* UPDATE_PARENT_DATA
* Persists a parent change for a moved node to the server via dd_ts_api
* (action: 'update_parent_data'). Called by swap_parent after the local
* in-memory and DOM state have already been updated, so the user sees
* the change immediately while the API call is in flight.
* (!) The @param annotation in the original said HTMLElement wrap_ts_object
* which is wrong — the parameter is an options object. Flagged; not changed.
* @see drag_and_drop.js
* @param {Object} options
* @param {string|number} options.section_id - Moved node's section_id.
* @param {string} options.section_tipo - Moved node's section_tipo.
* @param {string|number} options.old_parent_section_id - Previous parent's section_id.
* @param {string} options.old_parent_section_tipo - Previous parent's section_tipo.
* @param {string|number} options.new_parent_section_id - New parent's section_id.
* @param {string} options.new_parent_section_tipo - New parent's section_tipo.
* @returns {Promise<Object>} The raw api_response Promise from data_manager.request.
*   The caller AWAITS this and commits the local re-parent only on success
*   (P2-2 / CLI-04). It previously said "the await is intentionally omitted …
*   the caller attaches a .then()" — and that caller's .then() reverted nothing,
*   so a server failure left the tree showing a move the database never took.
*/
ts_object.prototype.update_parent_data = async function(options) {
	if(SHOW_DEBUG) {
		console.warn('*** update_parent_data options:', options);
	}

	const {
		section_id,
		section_tipo,
		old_parent_section_id,
		old_parent_section_tipo,
		new_parent_section_id,
		new_parent_section_tipo
	} = options

	// check vars
	if (!old_parent_section_id) {
		console.error('Invalid old_parent_section_id from options:', options);
		return false
	}

	// API call
		const rqo = {
			dd_api			: 'dd_ts_api',
			prevent_lock	: true,
			action			: 'update_parent_data',
			source			: {
				section_id				: section_id,
				section_tipo			: section_tipo,
				old_parent_section_id	: old_parent_section_id,
				old_parent_section_tipo	: old_parent_section_tipo,
				new_parent_section_id	: new_parent_section_id,
				new_parent_section_tipo	: new_parent_section_tipo
			}
		}
		// The caller AWAITS this result before committing anything locally
		// (P2-2 / CLI-04): the UI no longer updates ahead of the server.
		const api_response = data_manager.request({
			body : rqo
		})


	return api_response
}//end update_parent_data



/**
* HILITE_ELEMENT
* Adds the 'element_hilite' CSS class to the supplied element, optionally
* clearing all existing highlights first (clean_others=true, the default).
* Validates that element is a real DOM element node before proceeding.
* (!) The matches array is currently hard-coded to [element] — the
* commented-out querySelector that highlighted all same-term appearances
* is dead code left for future restoration.
* @param {HTMLElement} element - The element to highlight.
* @param {boolean} [clean_others=true] - When true, calls reset_hilites()
*   before adding the new highlight.
* @returns {number} Number of elements highlighted (0 on validation failure,
*   otherwise matches.length, currently always 1).
*/
ts_object.prototype.hilite_element = function(element, clean_others) {

	// element node is mandatory
		if (!element) {
			console.error('Empty hilite_element param element:', element);
			return 0
		}

		if (element.nodeType !== Node.ELEMENT_NODE) {
			console.error('element hilite is not a HTMLElment node:', element);
			return 0
		}

	// undefined clean_others case
		if (typeof clean_others==='undefined') {
			clean_others = true
		}

	// Remove current hilite elements
		if(clean_others!==false) {
			this.reset_hilites()
		}

	// hilite all appearances of current component (may appear more than once)
		// const matches = document.querySelectorAll(`.term[data-type="${element.dataset.type}"][data-section_tipo="${element.dataset.section_tipo}"][data-section_id="${element.dataset.section_id}"]`);
		const matches = [element]
		const matches_length = matches.length;
		for (let i = matches_length - 1; i >= 0; i--) {

			const node = matches[i]

			node.classList.add('element_hilite');
		}

	return matches_length
}//end hilite_element



/**
* RESET_HILITES
* Removes the 'element_hilite' CSS class from every element in the document
* that currently has it. Iterates in reverse to avoid live-NodeList issues.
* Called by hilite_element (when clean_others=true) and parse_search_result
* before applying a new search highlight set.
* @returns {boolean} Always true.
*/
ts_object.prototype.reset_hilites = function() {

	const matches	= document.querySelectorAll('.element_hilite');
	const len		= matches.length;
	for (let i = len - 1; i >= 0; i--) {
		matches[i].classList.remove("element_hilite");
	}

	return true
}//end reset_hilites



/**
* REFRESH_ELEMENT
* Triggers a content-only refresh of the term's DOM node (render_level:'content',
* destroy:false) and optionally highlights the term and runs a callback.
* Used by open_record's on_blur handler to update the visible label after an
* edit-window session, and by the indexation grid after a save.
* (!) The @return annotation in the original was wrong (said int matches_length).
* This method always returns true. Flagged; not changed.
* @param {boolean} [hilite=true] - Whether to highlight self.term_node after refresh.
* @param {Function} [callback] - Optional callback invoked with self.term_node as argument.
* @returns {Promise<boolean>} Always resolves to true.
*/
ts_object.prototype.refresh_element = async function(hilite=true, callback) {

	const self = this

	// fire common refresh action
	await self.refresh({
		render_level	: 'content',
		destroy			: false
	})

	// element to hilite
	if (hilite && self.term_node) {
		requestAnimationFrame( () => { self.hilite_element(self.term_node) })
	}

	// callback
	if (callback) {
		callback(self.term_node)
	}

	return true
}//end refresh_element



/**
* OPEN_RECORD
* Opens the full record editor for the given term in a secondary browser
* window. Reuses the existing window (by target name 'edit_window') when
* it is still open; navigates to the new URL if the record differs.
* Registers an on_blur callback on the window that triggers refresh_element
* on the matching ts_object instance so the tree label updates after a save.
* edit_window is stored on the prototype (shared across all instances) so
* that only a single edit window is open at a time per page.
* @param {number|string} section_id - Section ID of the record to open.
* @param {string} section_tipo - Section tipo of the record to open.
* @returns {boolean} Always true.
*/
ts_object.prototype.edit_window = null; // Class-level reference to the currently open edit window
ts_object.prototype.open_record = function(section_id, section_tipo) {

	const self = this

	// url
	const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
		tipo			: section_tipo,
		id				: section_id,
		mode			: 'edit',
		session_save	: false,
		menu			: false
	})

	// window managing
	if(self.edit_window===null || self.edit_window.closed) {

		const width_default = 1286

		const height	= window.screen.availHeight
		const width		= window.screen.availWidth > width_default
			? window.screen.availWidth
			: width_default

		self.edit_window = open_window({
			url		: url,
			target	: 'edit_window',
			width	: width_default,
			height	: height,
			top		: 0,
			left	: (width - width_default),
			on_blur : () => {
				// refresh the instance
				const instance = get_all_instances().find(el => parseInt(el.section_id)===parseInt(section_id) && el.section_tipo===section_tipo && el.model==='ts_object') || self
				if (instance) {
					instance.refresh_element()
				}else{
					console.error('Unable to get the instance');
				}
			}
		})

	}else{

		const current_query	= self.edit_window.location.href.split("?")[1]
		const new_query		= url.split("?")[1]
		if (current_query!==new_query) {
			self.edit_window.location.href = url
		}
		self.edit_window.focus();
	}


	return true
}//end open_record



/**
* ADD_CHILD
* Creates a new child thesaurus term record under this node by calling
* dd_ts_api (action: 'add_child'). On server-side failure the method
* hands the refusal to `handle_api_error` (one policy, one renderer). On success
* the caller is expected to refresh the children list.
* @returns {Promise<Object>} The raw api_response from the server.
*/
ts_object.prototype.add_child = async function() {

	// source
		const source = {
			section_id		: this.section_id,
			section_tipo	: this.section_tipo
		}

	// API call
		const rqo = {
			dd_api	: 'dd_ts_api',
			action	: 'add_child',
			source	: source
		}

	// API request
		const api_response = await data_manager.request({
			use_worker	: false,
			body		: rqo
		})

		// debug
		if(SHOW_DEBUG===true) {
			console.log('[ts_object.add_child] response', api_response)
		}

		if (!api_response) {

			// no answer at all (the transport always resolves an envelope, so this
			// is a caller/programming fault rather than a server one)
			await handle_api_error(new ApiError({
				code	: CLIENT_ERROR.BAD_RESPONSE,
				message	: 'Error on add_child. See server log for details'
			}), {wrapper: this.node})

		}else if (request_failed(api_response)) {

			// Problems found on add: the policy renders the refusal
			await handle_api_error(api_response.error, {wrapper: this.node})
		}


	return api_response
}//end add_child



/**
* DELETE_TERM
* Deletes a thesaurus term record from the database via the section's own
* delete_section method. The guard against deleting nodes that have children
* is enforced server-side; this method does not pre-check.
* After a successful delete:
*   - Calls caller.remove_children_item() to update the parent's in-memory tree.
*   - Removes the persisted expand state for this node from the local DB.
*   - Destroys the instance (instance map, events, and DOM node).
* @see section.delete_section
* @param {Object} options
* @param {string} options.section_tipo - Tipo of the term to delete.
* @param {string|number} options.section_id - Record ID of the term to delete.
* @returns {Promise<boolean>} Result of section.delete_section(); false on failure.
*/
ts_object.prototype.delete_term = async function(options) {

	const self = this

	// options
		const section_id		= options.section_id
		const section_tipo		= options.section_tipo
		// const caller_dataframe	= options.caller_dataframe || null

	// delete_diffusion_records
		const delete_diffusion_records = self.delete_diffusion_records ?? true

	// create the instance of the section called by the row of the portal,
	// section will be in list because it's not necessary get all data, only the instance context to be deleted it.
		const instance_options = {
			model			: 'section',
			tipo			: section_tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			mode			: 'list',
			lang			: self.lang,
			caller			: self,
			inspector		: false,
			filter			: false,
			id_variant		: 'delete_section'
		}
	// get the instance
		const section =	await get_instance(instance_options)

	// create the sqo to be used to find the section will be deleted
		const sqo = {
			section_tipo		: [section_tipo],
			filter_by_locators	: [{
				section_tipo	: section_tipo,
				section_id		: section_id
			}],
			limit				: 1
		}

	// call to the section and delete it
		const delete_section_result = await section.delete_section({
			sqo							: sqo,
			delete_mode					: 'delete_record',
			// caller_dataframe			: caller_dataframe,
			delete_diffusion_records	: delete_diffusion_records
		})

	// destroy section after use it
		section.destroy()

	// refresh parent children data and reclaim the deleted node
		if (delete_section_result && self.caller) {
			self.caller?.remove_children_item(self.data)

			// remove the persisted expand state of the deleted node
			data_manager.delete_local_db_data(self.id, 'status')

			// destroy self: instance map entry, events, dependencies and DOM
			await self.destroy(
				true, // delete_self
				true, // delete_dependencies
				true // remove_dom
			)
		}

		if(SHOW_DEBUG) {
			console.log('[ts_object.delete_term] deleted self:', self);
		}

	return delete_section_result
}//end delete_term



/**
* SWAP_PARENT
* Moves a ts_object node from one parent to another in response to a
* drag-and-drop operation. Self (the instance swap_parent is called on)
* is the drop TARGET (new parent).
* Operations performed in order:
*   1. Validates that the move is legal (no self-drop, no duplicate child).
*   2. Fires update_parent_data() asynchronously to persist on the server.
*   3. Updates moving_instance.caller and .ts_parent to reflect the new parent.
*   4. Calls rekey() to re-register the instance under its new cache key.
*   5. Moves moving_instance between the ar_instances destroy-cascades.
*   6. Moves the DOM node (appendChild to target children_container).
*   7. Recalculates virtual_order and refreshes the term line.
*   8. Schedules (via dd_request_idle_callback) the parent state updates and
*      highlight on the moved term.
* @param {Object} options
* @param {Object} options.moving_instance - The ts_object being dragged.
* @param {Object} options.old_parent_instance - The ts_object that was the
*   previous parent of moving_instance.
* @returns {Promise<boolean>} false on validation failure; true on success.
*/
ts_object.prototype.swap_parent = async function (options) {

	const self = this

	// options
	const {
		moving_instance,
		old_parent_instance
	} = options

	// check vars
	if (!moving_instance) {
		console.error('[ts_object.on_drop] No moving_instance is received.', options);
		return false;
	}
	if (!old_parent_instance) {
		console.error('[ts_object.on_drop] No old_parent_instance is received.', options);
		return false;
	}

	// target instance is self (currently dropped wrapper). Set for clarify names.
	const target_instance = self

	// Validate moving instance. Don't proceed if moving instance is the same as target.
	if ( moving_instance.ts_id === target_instance.ts_id ) {
		console.warn('Invalid action: moving and target instances are the same.');
		return false;
	}

	// Validate target instance. Check if parent already contains current child.
	const target_instance_ar_children_data = target_instance.children_data?.ar_children_data || []
	const found = target_instance_ar_children_data.find(el => el.ts_id === moving_instance.ts_id)
	if (found) {
		console.log('Ignored action. Parent instance already contains this node.', found);
		return false;
	}

	// children_container. Check the container for children within the target.
	// If no children container, log an error and stop.
	const children_container = target_instance.children_container
	if (!children_container) {
		console.warn('No children_container found in the target instance:', target_instance);
		return false;
	}

	// update_parent_data. Request API to update parent data
	const update_parent_data_options = {
		section_id				: moving_instance.section_id,
		section_tipo			: moving_instance.section_tipo,
		old_parent_section_id	: old_parent_instance.section_id,
		old_parent_section_tipo	: old_parent_instance.section_tipo,
		new_parent_section_id	: target_instance.section_id,
		new_parent_section_tipo	: target_instance.section_tipo
	}
	// AWAIT THE SERVER BEFORE COMMITTING THE MOVE (P2-2 / CLI-04).
	//
	// This fired update_parent_data WITHOUT awaiting and then committed the
	// re-parent locally regardless — instance reassignment, rekey, destroy-cascade
	// move, appendChild, virtual_order recompute — while the `.then()` showed an
	// error notification and REVERTED NOTHING.
	//
	// So on a server failure the curator saw an error toast AND a tree showing the
	// term under its new parent: the client and the server disagreeing about where
	// a heritage record sits, with the screen asserting the version that did not
	// happen. The next reload silently undoes it, which is the worst way to find
	// out. The server side is atomic and correct; the divergence was entirely the
	// client's refusal to wait.
	const api_response = await self.update_parent_data(update_parent_data_options)
	if (!response_data(api_response)) {
		console.error('Error on update_parent_data. Unable to continue.');
		const msg = request_failed(api_response)
			? error_text(api_response.error)
			: 'Error on update parent data.'
		event_manager.publish('notification', {
			msg			: msg,
			type		: 'error',
			remove_time	: 10000
		})
		// NOTHING LOCAL HAS CHANGED YET, which is the whole point of moving this
		// above the commit: refusing here leaves the tree exactly as the server
		// still has it, so the screen and the database agree.
		return false
	}
	event_manager.publish('notification', {
		msg			: get_label.saved || 'OK',
		type		: 'success',
		remove_time	: 1200
	})

	// update moving instance caller.
	// It is important to allow the term to be moved again without causing any inconsistencies.
	moving_instance.caller		= target_instance
	moving_instance.ts_parent	= target_instance.ts_id

	// rekey. ts_parent is part of the instances map key: re-register under
	// the new key to prevent stale-key duplicates on later get_instance calls
	moving_instance.rekey()

	// move the instance between the parents' destroy cascades (ar_instances)
	const old_index = old_parent_instance.ar_instances.indexOf(moving_instance)
	if (old_index!==-1) {
		old_parent_instance.ar_instances.splice(old_index, 1)
	}
	if (!target_instance.ar_instances.includes(moving_instance)) {
		target_instance.ar_instances.push(moving_instance)
	}

	// Move moving instance node from old parent to the new one (current dropped)
	target_instance.children_container.appendChild( moving_instance.node );

	// Update moving instance virtual_order. INDEX-based (audit P2-31 / CLI-30):
	// the target's descriptor children in DATA plus the moved one — never a DOM
	// count, because a windowed children_container holds only the rows in reach.
	const target_descriptors = (target_instance.children_data?.ar_children_data || [])
		.filter(el => el.is_descriptor===true && el.ts_id!==moving_instance.ts_id)
		.length
	moving_instance.virtual_order = target_descriptors + 1
	// Refresh the instance (without call API) to update the order value.
	await moving_instance.refresh({
		build_autoload	: false, // Do not load data from API
		render_level	: 'content',
		destroy			: false
	})

	// update_arrow_state. If the instance has no children, then the arrow icon should be hidden.
	// old_parent_instance.update_arrow_state(false)
	dd_request_idle_callback(
		async () => {

			// Update old_parent_instance (remove child)
			old_parent_instance.remove_children_item( moving_instance.data )
			await old_parent_instance.update_children_state({
				render: false,  // No need to re-render, just refresh content
				refresh_content: true,
				show_children: old_parent_instance.is_open
			})
			if(SHOW_DEBUG===true) {
				console.log('Updated old_parent_instance :', old_parent_instance);
			}

			// Update target_instance (add child)
			target_instance.add_children_item( moving_instance.data )
			await target_instance.update_children_state({
				render: false,  // DOM already updated above
				refresh_content: true,
				show_children: true
			})

			// Hilite moved term
			const term_node = moving_instance.term_node
			if (term_node) {
				self.hilite_element(term_node)
			}

			if(SHOW_DEBUG===true) {
				console.log('Updated target_instance :', target_instance);
			}
		}
	);


	return true
}//end swap_parent



/**
* SELECT_FIRST_INPUT_IN_EDITOR
* Focuses and selects all text in the first <input> found inside the given
* inline editor container, and hides the container when the value changes.
* Called after show_component_in_ts_object renders an inline term editor so
* the user can begin typing immediately.
* @param {HTMLElement} element_data_div - The inline component editor wrapper
*   (typically self.data_container).
* @returns {boolean} Always true.
*/
ts_object.prototype.select_first_input_in_editor = function(element_data_div) {

	// Focus first input element
		const first_input = element_data_div.querySelector('input')
		if (first_input) {
			// Select all content
			first_input.select()
			// Hide editor on change value
			const change_handler = (e) => {
				element_data_div.style.display = 'none'
			}
			first_input.addEventListener('change', change_handler)
		}

	return true
}//end select_first_input_in_editor



// Duration of the data_container height swap animation, in ms.
const DATA_CONTAINER_ANIMATION_MS = 180

/**
* ANIMATE_DATA_CONTAINER_HEIGHT
* Animates a data_container from a previously measured height to its current
* (already laid out) one, so that swapping component editors moves the tree
* below it smoothly instead of in a single jump.
*
* Called AFTER the DOM swap: from_height must be captured before the mutation
* and the container must already hold its final content when this runs.
*
* No-ops when the height did not change, when the Web Animations API is
* unavailable, or when the user asked for reduced motion. A container can only
* have one height animation in flight; a new one cancels the previous so rapid
* clicking does not stack conflicting animations.
*
* overflow is forced to hidden for the duration so shrinking does not spill the
* outgoing content outside the container. This does not alter the measured
* height (the container already contains its floated .wrapper_component child).
*
* @param {HTMLElement} container - The .data_container node.
* @param {number} from_height - offsetHeight measured before the DOM mutation.
* @returns {Animation|null} The running animation, or null when skipped.
*/
const animate_data_container_height = function(container, from_height) {

	const to_height = container.offsetHeight

	// nothing to animate
		if (from_height===to_height) {
			return null
		}

	// capability / preference guards
		if (typeof container.animate!=='function') {
			return null
		}
		if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			return null
		}

	// cancel any in-flight animation on this container (rapid clicks)
		if (container.height_animation) {
			container.height_animation.cancel()
		}

	container.style.overflow = 'hidden'

	const animation = container.animate(
		[
			{ height: from_height + 'px' },
			{ height: to_height + 'px' }
		],
		{
			duration	: DATA_CONTAINER_ANIMATION_MS,
			easing		: 'ease-out'
		}
	)
	container.height_animation = animation

	// restore natural layout when done. cancel() rejects the finished promise,
	// and in that case the superseding animation owns the cleanup.
		const restore = () => {
			if (container.height_animation===animation) {
				container.height_animation	= null
				container.style.overflow	= ''
			}
		}
		animation.finished.then(restore).catch(restore)


	return animation
}//end animate_data_container_height



/**
* SHOW_COMPONENT_IN_TS_OBJECT
* Toggles the inline display of one or more component editors inside the
* term's data_container. On first call for a tipo it builds, renders and
* injects the component. On a second call for the same tipo it destroys the
* component and returns (toggle-off). On a call for a different tipo it
* destroys all current components and renders the new one(s).
* For term-type components a 'save_*' event subscription updates self.term_text
* and self.data.ar_elements immediately so the tree label changes without a
* round-trip, then destroys the component via dd_request_idle_callback.
*
* Layout stability: the incoming components are built and rendered OFF-DOM, and
* only then swapped in against the outgoing ones in a single synchronous DOM
* mutation. The container therefore never collapses to a loader height while the
* new component is fetched — it goes straight from the outgoing layout to the
* incoming one, animated by animate_data_container_height. While loading, the
* outgoing component is dimmed in place ('swapping' class) rather than replaced
* by an in-flow loader, so waiting costs no layout at all.
*
* @param {Object} options
* @param {string|string[]} options.tipo - One or more component tipos to show.
*   A comma-separated string is also accepted (split internally).
* @param {string} options.type - Display role hint: 'term' | 'icon' | etc.
*   Determines whether a save-and-close subscription is set up.
* @param {string} options.model - Component model name, e.g. 'component_json'.
* @returns {Promise<boolean>} Always resolves to true.
*/
ts_object.prototype.show_component_in_ts_object = async function(options) {

	const self = this

	// options
		const {
			tipo, // array expected. String is accepted too. e.g. 'ontology17'
			type, // string e.g. 'icon'
			model // string e.g. 'component_json'
		} = options

	// short vars
		const section_tipo	= self.section_tipo
		const section_id	= self.section_id
		const lang			= page_globals.dedalo_data_lang
		const tipos			= Array.isArray(tipo) ? tipo : tipo.split(',') // handle always as array

	// delete the previous registered events
		self.events_tokens.forEach(token => event_manager.unsubscribe(token))
		self.events_tokens = []

	// data_contanier
		const element_data_contanier = self.data_container

	// swap_seq. Clicking several buttons faster than a component loads starts
	// overlapping calls. Each claims a token; only the holder of the newest one
	// may touch the container, so the last click wins and the earlier ones
	// discard whatever they built instead of stacking it into the DOM.
		const swap_seq = (self.show_component_seq || 0) + 1
		self.show_component_seq = swap_seq

	// from_height. Measured before ANY mutation; animate_data_container_height
	// animates from here to whatever the incoming content lays out to. While a
	// previous swap is still animating this reads its current animated height,
	// which is exactly the right visual starting point.
		const from_height = element_data_contanier.offsetHeight

	// swapping state. The outgoing component stays in place and is merely dimmed
	// (see ts_object.less) while the incoming one is built off-DOM, so the
	// container holds its height for the whole round-trip at zero layout cost.
	// (!) No in-flow loader node here on purpose: there is no gap to fill any
	// more, and the clicked button already carries its own 'loading_spinner'.
	// Only the newest call may clear the state — see the superseded check below.
		const set_swapping = function(on) {
			element_data_contanier.classList.toggle('swapping', on)
		}

	// toggle-off scan. Reverse order over the container as the user sees it,
	// stopping at the first wrapper that already renders the requested tipo —
	// that click closes it instead of loading anything.
	// (!) tipo here is the raw options.tipo value (string or array); the
	// comparison works only when options.tipo is a string. When an array
	// is passed, this never matches and the toggle-off path is skipped.
		const current_wrappers	= [...element_data_contanier.children]
		let toggle_off			= false
		for (let i = current_wrappers.length - 1; i >= 0; i--) {
			const component_wrapper = current_wrappers[i]
			if (component_wrapper.instance && component_wrapper.instance.tipo===tipo) {
				// this component already exists. Remove it and stop
				toggle_off = true
				break
			}
		}

	// detach_outgoing. Empties the container synchronously so the swap is a
	// single, paint-free DOM mutation, and returns the detached wrappers for
	// teardown. Re-reads the live children on purpose: it must clear whatever is
	// actually in the container at swap time, not a stale entry snapshot.
		const detach_outgoing = function() {
			const outgoing = [...element_data_contanier.children]
			outgoing.forEach(component_wrapper => component_wrapper.remove())
			return outgoing
		}

	// destroy_outgoing. Instance teardown, awaited.
	// (!) common.prototype.destroy is async and only removes the DOM node after
	// its internal awaits — a fire-and-forget call lets the outgoing node linger
	// in the container while the incoming one is inserted. The nodes are already
	// detached by detach_outgoing, hence remove_dom=false here.
		const destroy_outgoing = async function(outgoing) {
			const outgoing_length = outgoing.length
			for (let i = 0; i < outgoing_length; i++) {
				const instance = outgoing[i].instance
				if (instance) {
					await instance.destroy(true, true, false)
				}
			}
			return true
		}

	// toggle-off case. Nothing to load: collapse straight away and animate it.
		if (toggle_off===true) {
			set_swapping(false)
			const outgoing = detach_outgoing()
			animate_data_container_height(element_data_contanier, from_height)
			await destroy_outgoing(outgoing)
			return true
		}

	// swapping state on for the whole build+render round-trip
		set_swapping(true)

	// render_component_node function
	// (!) Builds and renders OFF-DOM. The returned node is inserted by the caller
	// only once every requested component is ready.
		const components = [] // array of created component instances
		const render_component_node = async function(tipo, key) {

			// component instance
				const current_component = await get_instance({
					model			: model,
					section_tipo	: section_tipo,
					section_id		: section_id,
					tipo			: tipo,
					lang			: lang,
					mode			: 'edit',
					// view			: 'default', // do not force view here (let component to decide his view)
					id_variant		: new Date().getTime()
				})

			// components
				components.push(current_component)

			// term edit case
				if(type==='term') {

					// update value, subscription to the changes: if the DOM input value was changed, observers DOM elements will be changed own value with the observable value
					const save_handler = function() {

						const caller = current_component

						const ar_values = []
						switch (caller.model) {
							case 'component_portal': {
								const data = caller.datum.data.filter(el => el.tipo !== caller.tipo)
								ar_values.push(...data.map(el => el.value))
								break;
							}
							default: {
								const components_length = components.length
								for (let i = 0; i < components_length; i++) {
									ar_values.push(...components[i].data.entries)
								}
								break;
							}
						}

						const value = ar_values.map(el => el.value).join(' ')
						// change the value of the current DOM element
						self.term_text.textContent = value

						// Update ts_object instance
						const ar_elements = (self.data?.ar_elements && Array.isArray(self.data.ar_elements))
							? self.data.ar_elements
							: [];
						const term = ar_elements.find(el => el && el.type === 'term');
						if (term && 'value' in term) {
							term.value = value;
						}

						dd_request_idle_callback(
							() => {
								// destroy
								// current_component.destroy(true, true, true)
								components.forEach((component) => {
									component.destroy(true, true, true)
								});
								// clean up array of components
								while(components.length > 0) {
									components.pop();
								}
							}
						)
					}
					const token = event_manager.subscribe('save_' + current_component.id_base, save_handler)
					self.events_tokens.push(token)
				}

				// build and render component
					const build_result = await current_component.build(true)
					const component_node = !build_result
						? (function(){
							const on_retry = async () => {
								const retry_result = await current_component.build(true)
								const new_node = retry_result
									? await current_component.render()
									: render_failure()
								new_node.instance = current_component
								return new_node
							}
							const render_failure = () => {
								const node = render_build_failure({
									instance	: current_component,
									on_retry,
									class_name	: 'wrapper_component error_alert'
								})
								node.failed = true
								return node
							}
							return render_failure()
						  })()
						: await current_component.render()
					// set pointer instance to DOM node
					component_node.instance = current_component

			return component_node
		}//end render_component_node

	// build every requested component off-DOM
		const component_nodes	= []
		const tipos_length		= tipos.length
		for (let i = 0; i < tipos_length; i++) {
			const current_tipo = tipos[i]
			component_nodes.push( await render_component_node(current_tipo, i) )
		}

	// superseded case. A newer click claimed the container while this one was
	// building. Drop what was built (it was never inserted) and leave the DOM
	// and the swapping state untouched — that newer call owns them now.
		if (self.show_component_seq!==swap_seq) {
			const components_length = components.length
			for (let i = 0; i < components_length; i++) {
				await components[i].destroy(true, true, true)
			}
			return true
		}

	// swap. ONE synchronous DOM mutation: outgoing nodes out, incoming nodes in
	// — no frame is painted with an empty container.
	// (!) Nothing may await between the check above and the appendChild below,
	// or another call could interleave into a half-swapped container.
		set_swapping(false)
		const outgoing = detach_outgoing()
		const incoming_fragment = new DocumentFragment()
		component_nodes.forEach(component_node => incoming_fragment.appendChild(component_node))
		element_data_contanier.appendChild(incoming_fragment)

	// animate the honest height delta (outgoing layout → incoming layout)
		animate_data_container_height(element_data_contanier, from_height)

	// activate. Deferred until the node is in the DOM, otherwise the component
	// would be activated (and focused) while still detached.
		if (components.length > 0) {
			dd_request_idle_callback(
				() => {
					ui.component.activate(components[0])
				}
			)
		}

	// outgoing instance teardown. Awaited so the caller's .then() (which clears
	// the button spinner) does not fire while destroy is still in flight.
		await destroy_outgoing(outgoing)


	return true
}//end show_component_in_ts_object



/**
* SHOW_INDEXATIONS
* Loads and renders a dd_grid of records that index this term. Acts as a
* toggle: calling it while the indexations_container is visible hides it;
* calling it when hidden shows the grid (re-using a previously built dd_grid
* when available via button_obj.dd_grid, otherwise building from scratch).
* The grid is scoped by totals_group (target section tipos) and
* filter_by_locators. Pagination is limited to 200 rows (micro view).
* @param {Object} options
* @param {string} options.uid - Unique identifier for the invoking button; used
*   to detect same-caller re-opens and prevent duplicate grids.
* @param {Object} options.button_obj - The button DOM element or object; the
*   built dd_grid is stored on button_obj.dd_grid for reuse.
* @param {string} options.section_tipo - Section tipo of this term.
* @param {string|number} options.section_id - Section ID of this term.
* @param {string} options.component_tipo - Tipo of the indexation component to query.
* @param {HTMLElement} options.target_div - Container to render the grid into.
* @param {*} [options.value=null] - Optional value filter forwarded to the API.
* @param {Object} [options.pagination={}] - Pagination options.
* @param {Array} [options.totals_group=[{key:'all'}]] - Target section filter groups.
* @param {Array} [options.filter_by_locators=[]] - Additional locator filters.
* @param {number|null} [options.total=null] - Pre-known result count.
* @returns {Promise<boolean|void>} false when target_div is missing; void otherwise
*   (the grid is rendered asynchronously via .then()).
*/
ts_object.prototype.show_indexations = async function(options) {

	// options
		const uid					= options.uid
		const button_obj			= options.button_obj
		const section_tipo			= options.section_tipo
		const section_id			= options.section_id
		const component_tipo		= options.component_tipo
		const target_div			= options.target_div
		const value					= options.value || null
		const pagination			= options.pagination || {}
		const totals_group			= options.totals_group || [{key: 'all'}]
		const filter_by_locators	= options.filter_by_locators || []

	// pagination vars
		const total = options.total || null

	// check mandatory target_div (the node's indexations_container)
		if (!target_div) {
			console.error('[ts_object.show_indexations] Error: target_div is mandatory. options:', options);
			return false
		}

	// get the filter section
		const target_section = totals_group.map(el => el.key)

	// empty the target_div container
		while (target_div.firstChild) {
			target_div.removeChild(target_div.firstChild);
		}

	// close the target_div when is open and the caller component is the same
		if (!target_div.classList.contains('hide') && target_div.uid === uid) {
			// hide only
			target_div.classList.add('hide')
			return
		}

	// already loaded. render the dd_grid again and toggle to visible
		if( button_obj.dd_grid){
			const dd_grid = button_obj.dd_grid
			dd_grid.render()
			.then(function(node){
				target_div.appendChild(node)
				// force reload again
				target_div.classList.remove('hide')
				target_div.uid = uid
			})
			return
		}

	// rqo. create
		const rqo = {
			action	: 'get_indexation_grid',
			source	: {
				section_tipo	: section_tipo,
				section_id		: section_id,
				tipo			: component_tipo,
				value			: value // ["oh1",] array of section_tipo \ used to filter the locator with specific section_tipo (like 'oh1')
			},
			sqo: {
				mode				: 'related',
				section_tipo		: target_section,
				total				: total,
				limit				: 200,
				offset				: 0,
				filter_by_locators	: filter_by_locators
			}
		}

	// dd_grid
		const dd_grid = await get_instance({
			model				: 'dd_grid',
			section_tipo		: section_tipo,
			section_id			: section_id,
			tipo				: component_tipo,
			mode				: 'list',
			view				: 'indexation',
			lang				: page_globals.dedalo_data_lang,
			rqo					: rqo,
			id_variant			: uid,
			totals_group 		: totals_group,
			paginator_options	: {
				view 				: 'micro',
				show_interface 		: {
					show_all : false
				}
			}
		})
		await dd_grid.build(true)
		// assign the dd_grid to be reused by same caller.
		button_obj.dd_grid = dd_grid
		dd_grid.render()
		.then(function(node){
			target_div.appendChild(node)
			target_div.classList.remove('hide')
			target_div.uid = uid
		})
}//end show_indexations



/**
* PARSE_SEARCH_RESULT
* Entry point for rendering search results in the thesaurus tree.
* Called from render_area_thesaurus.list (not used for regular tree render).
* Executes a four-phase pipeline:
*   1. build_search_instances  — maps rows to node_info, creates/updates root instances.
*   2. hierarchize_search_instances — links children to parents, collects branches to open.
*   3. open_search_branches    — opens branches top-down so children are always
*      attached before their own children are rendered (no detached-node races).
*   4. hilite_search_results   — applies 'element_hilite', scrolls to first match,
*      publishes a notification. AWAITED: resolves only after the hilite styles
*      are painted and the scroll decision is committed, so the caller's
*      'loading' state (area_thesaurus navigate) covers the whole visual
*      sequence and is removed in sync with the result.
* Orphaned nodes (no ancestor in the data set) are logged and notified.
* (!) Method name in original was 'PARSER_SEARCH_RESULT' — corrected in doc-block;
* the function identifier parse_search_result is unchanged.
* @param {Array} data - Full search result, including all ancestor rows from root
*   to each matched node. Each item is a ts node data object with fields:
*   { section_tipo, section_id, order, ts_id, ts_parent, is_descriptor,
*     ar_elements, permissions_*, ... }
* @param {Array} to_hilite - Locators of the actual search hits (leaf nodes).
*   Shape: [{ section_tipo: string, section_id: string }, ...]
* @returns {Promise<boolean>} true on success; false when data is invalid.
*/
ts_object.prototype.parse_search_result = async function( data, to_hilite ) {
	const start_time = performance.now();
	if(SHOW_DEBUG===true) {
		console.warn('parse_search_result data:', data, to_hilite);
	}

	const self = this

	if (!data || !Array.isArray(data)) {
		console.error('Invalid data provided to parse_search_result');
		// Display result info
		event_manager.publish('notification', {
			msg			: `Invalid empty data provided to parse_search_result`,
			type		: 'error',
			remove_time	: 7000
		})
		return false;
	}

	// Pre-process 'to_hilite' for faster lookup and type consistency
	const hilite_set = new Set(
		to_hilite.map(el => `${el.section_tipo}_${el.section_id}`)
	);

	// 1. Build the node info map from the plain result data and make sure the
	// root instances exist and are rendered. Non-root nodes are NOT created
	// here: they are rendered by their parent's render_child, so a child's
	// wrapper is never created before its parent container exists (this
	// removes the detached-node race the old depth-sort workaround patched).
	const node_info = await build_search_instances(self, data)

	// Reset possible previous hilites.
	self.reset_hilites()

	// 2. Hierarchize: link every child data to its parent info and collect the
	// branches to open. Orphans (results whose ancestor is missing from the
	// server data) are reported instead of silently skipped.
	const { to_open, orphans } = hierarchize_search_instances(node_info)

	if (orphans.length > 0) {
		console.error('[parse_search_result] Orphaned results, ancestor missing from data:', orphans);
		event_manager.publish('notification', {
			msg			: `Some results could not be placed in the tree (${orphans.length})`,
			type		: 'warning',
			remove_time	: 6000
		})
	}

	// 3. Open the branches, top-down by construction (explicit recursion:
	// a child branch only opens after its parent rendered it)
	await open_search_branches(node_info, to_open)

	// 4. Hilite found nodes and scroll to the first one.
	// (!) Awaited on purpose: the 'loading' state of the calling navigate()
	// stays visible until the hilite is painted and the scroll decision is
	// taken, instead of disappearing before the user sees any result.
	await hilite_search_results(node_info, hilite_set, to_hilite.length)

	// debug
	if(SHOW_DEBUG===true) {
		console.log(`_*_Time to parse search result: ${(performance.now() - start_time).toFixed(2)}ms`);
	}


	return true
}//end parse_search_result



/**
* BUILD_SEARCH_INSTANCES
* Phase 1 of parse_search_result.
* Builds a plain-data node_info Map from the search result rows and ensures
* root instances (ts_parent === 'root') exist, are in 'search' mode, and
* are rendered so that deeper nodes have parent containers to attach to.
* Existing root instances have their mutable (non-key) properties updated
* in place; new ones are created via ts_object.get_instance + build + render.
* Non-root nodes are intentionally NOT created here — they are created by
* their parent's render_children call in open_search_branches (phase 3).
* @param {Object} self - The ts_object instance that initiated the search
*   (effectively the area-level node whose parse_search_result was called).
* @param {Array} data - Search result rows (full ancestry path, root to leaf).
* @returns {Promise<Map>} node_info — Map keyed by ts_id; values are
*   { key: string, data: Object, children: Array }.
*/
const build_search_instances = async function(self, data) {

	const node_info = new Map()

	const root_caller = self.caller // area_thesaurus | area_ontology

	const data_length = data.length
	for (let i = 0; i < data_length; i++) {

		const data_item = data[i]

		// set non included 'thesaurus_mode' that is needed to create the instance id.
		// Values: default|relation
		data_item.thesaurus_mode = self.thesaurus_mode

		const key = key_instances_builder(data_item); // normalized id of the instance

		node_info.set(data_item.ts_id, {
			key			: key,
			data		: data_item,
			children	: [] // filled by hierarchize_search_instances
		})

		// root items only: ensure instance exists and is rendered
		if (data_item.ts_parent === 'root') {

			const found_instance = get_instance_by_id(key)
			if (found_instance) {

				// Instance already exists — refresh mutable (non-key) props
				if(SHOW_DEBUG===true) {
					console.log('==== Matched already existing root instance:', key, found_instance);
				}
				found_instance.caller		= root_caller
				found_instance.linker		= self.linker
				found_instance.area_model	= root_caller.model
				found_instance.is_ontology	= (root_caller.model === 'area_ontology')
				found_instance.mode			= 'search'
				found_instance.data			= data_item

			}else{

				// New root instance
				const new_instance = await ts_object.get_instance({
					// key_parts
					section_tipo		: data_item.section_tipo,
					section_id			: data_item.section_id,
					children_tipo		: data_item.children_tipo,
					target_section_tipo	: null,
					thesaurus_mode		: self.thesaurus_mode,
					ts_parent			: data_item.ts_parent,
					// non-key props
					caller				: root_caller,
					linker				: self.linker,
					is_root_node		: true,
					ts_id				: data_item.ts_id,
					order				: data_item.order,
					area_model			: root_caller.model,
					is_ontology			: root_caller.model === 'area_ontology',
					mode				: 'search', // hide some elements like 'order'
					data				: data_item  // inject row as data itself
				})
				if(SHOW_DEBUG===true) {
					console.log('++++ Created new root instance:', key, new_instance);
				}

				// Build the instance without load from API (data is already injected)
				await new_instance.build(false)
				// Render the instance
				await new_instance.render()
			}
		}
	}

	return node_info
}//end build_search_instances



/**
* HIERARCHIZE_SEARCH_INSTANCES
* Phase 2 of parse_search_result.
* Pure data transformation — no instances, no DOM side effects.
* Iterates node_info, links each non-root node's data into its parent's
* info.children array (deduped by ts_id), and accumulates ts_ids of nodes
* whose branches must be opened. Nodes whose parent is absent from node_info
* are collected as orphans (reported to the caller).
* @param {Map} node_info - Map built by build_search_instances.
* @returns {{to_open: Set<string>, orphans: Array<string>}}
*   to_open: Set of ts_id strings for branches that must be expanded.
*   orphans: Array of ts_id strings whose ancestor was not in the data.
*/
const hierarchize_search_instances = function(node_info) {

	const to_open = new Set()
	const orphans = []

	for (const [ts_id, info] of node_info) {

		// root nodes have no parent to link
		if (info.data.ts_parent === 'root') {
			continue;
		}

		const parent_info = node_info.get(info.data.ts_parent)
		if (!parent_info) {
			// ancestor missing from the server data: report (do not vanish)
			orphans.push(ts_id)
			continue;
		}

		// add as child of the parent (dedupe by ts_id)
		const child_found = parent_info.children.some(el => el.ts_id === ts_id)
		if (!child_found) {
			parent_info.children.push(info.data)
		}

		// the parent branch must be opened to show this node
		to_open.add(info.data.ts_parent)
	}

	return { to_open, orphans }
}//end hierarchize_search_instances



/**
* OPEN_SEARCH_BRANCHES
* Phase 3 of parse_search_result.
* Opens the branches identified by to_open using an inner recursive
* open_branch function. The key contract: a child branch is only processed
* AFTER its parent's render_children has synchronously attached the child
* wrapper to the DOM, so the open order is top-down by construction.
* This removes the detached-node race that earlier depth-sort workarounds
* attempted to fix.
* (!) Relies on render_children synchronously inserting DOM nodes before its
* returned Promise resolves. If that assumption ever breaks, the recursive
* cascade will attempt to look up instances that do not yet have DOM nodes.
* @param {Map} node_info - Map built by build_search_instances.
* @param {Set<string>} to_open - Set of ts_id strings to expand.
* @returns {Promise<boolean>} Always resolves to true.
*/
const open_search_branches = async function(node_info, to_open) {

	const open_branch = async (ts_id) => {

		if (!to_open.has(ts_id)) {
			return // leaf: nothing to open below
		}

		const info = node_info.get(ts_id)

		// resolve the live instance. For roots it was rendered in phase 1;
		// for deeper nodes the parent's render_children just created it
		// (same key: key parts are identical to render_child's) — but a windowed
		// parent (row_window) holds only the children in reach, so the child is
		// REVEALED first: the window re-centres on it and materializes it
		if (info.data.ts_parent !== 'root') {
			const parent_info = node_info.get(info.data.ts_parent)
			const parent_instance = parent_info ? get_instance_by_id(parent_info.key) : null
			if (parent_instance && typeof parent_instance.reveal_child==='function') {
				await parent_instance.reveal_child(ts_id)
			}
		}
		const instance = get_instance_by_id(info.key)
		if (!instance) {
			console.error('[open_search_branches] Instance not found for node:', ts_id, info.key);
			return
		}

		if(SHOW_DEBUG===true) {
			console.log('Opening hierarchized branch:', ts_id, instance);
		}

		// merge the hierarchized children into the instance children_data
		// (preserves children already visible when the node was open before
		// the search, exactly like the previous add_children_item flow)
		instance.children_data = instance.children_data || {
			ar_children_data	: [],
			pagination			: null
		}
		instance.children_data.ar_children_data = instance.children_data.ar_children_data || []
		for (const child_data of info.children) {
			const exists = instance.children_data.ar_children_data.some(el => el.ts_id === child_data.ts_id)
			if (!exists) {
				instance.children_data.ar_children_data.push(child_data)
			}
		}

		// Render and attach children nodes (synchronous attach: when this
		// resolves the children wrappers and containers exist)
		await instance.render_children({
			clean_children_container	: true,
			children_data				: instance.children_data
		})

		// project open state
		instance.is_open = true
		instance.sync_open_dom()

		// recurse into the children branches
		for (const child_data of info.children) {
			await open_branch(child_data.ts_id)
		}
	}

	// start from root-level nodes (their parent is 'root' or not part of the
	// opened set, i.e. already visible)
	for (const ts_id of to_open) {
		const info = node_info.get(ts_id)
		if (!info) {
			continue
		}
		const parent_in_set = to_open.has(info.data.ts_parent)
		if (!parent_in_set) {
			await open_branch(ts_id)
		}
	}

	return true
}//end open_search_branches



/**
* HILITE_SEARCH_RESULTS
* Phase 4 of parse_search_result.
* Applies 'element_hilite' to term_node of each matched instance using
* dd_request_idle_callback (deferred after the expensive branch rendering
* to avoid blocking). Scrolls to the first match via scroll_to_node (which
* skips the scroll when the node is already in view) and publishes a
* notification with the hit count.
* The returned Promise resolves AFTER the hilite styles have been painted
* (one requestAnimationFrame) and the scroll decision is committed. Callers
* showing a 'loading' state (area_thesaurus navigate) await it so the state
* is removed in sync with the visual result.
* @param {Map} node_info - Map built by build_search_instances.
* @param {Set<string>} hilite_set - Set of ts_id strings to highlight.
* @param {number} total_found - Total number of search matches (for notification).
* @returns {Promise<boolean>} true once the hilite is committed.
*/
const hilite_search_results = function(node_info, hilite_set, total_found) {

	return new Promise((resolve) => {

		dd_request_idle_callback(async () => {

			// Set node to scroll. Used to scroll page when is needed.
			let node_to_scroll = null

			for (const ts_id of hilite_set) {

				const info = node_info.get(ts_id)
				if (!info) {
					continue
				}
				const instance = get_instance_by_id(info.key)
				if (!instance || !instance.term_node) {
					continue
				}

				if(SHOW_DEBUG===true) {
					console.log('Hiliting instance:', ts_id, instance);
				}
				// already inside an idle callback: the class application will be
				// painted in the next frame without a per-node rAF deferral
				instance.hilite_element(instance.term_node, false)

				if (!node_to_scroll) {
					// scroll page to first found element
					node_to_scroll = instance.term_node
				}
			}

			// wait one paint frame: the 'element_hilite' styles are on screen
			// before the caller removes its 'loading' state
			await new Promise((r) => requestAnimationFrame(() => r(true)))

			// scroll page to first found element (scroll_to_node itself skips
			// the scroll when the node is already fully visible)
			if (node_to_scroll) {
				when_in_dom(node_to_scroll, ()=> {
					scroll_to_node(node_to_scroll)
				});
			}

			// Display result info
			event_manager.publish('notification', {
				msg			: `Displaying ${total_found} records`,
				type		: total_found > 0 ? 'success' : 'warning',
				remove_time	: total_found == 1 ? 1000 : 6000
			})

			resolve(true)
		})
	})
}//end hilite_search_results



/**
* SCROLL_TO_NODE
* Scrolls the viewport to center the given DOM node ONLY when it is out of
* view. When the node is already fully visible nothing is scrolled (a single
* delayed verification covers late layout shifts from slow tree parses: it
* scrolls again only if the node is no longer visible).
* When a scroll is needed it uses an IntersectionObserver + setInterval retry
* strategy. Stops when the element reaches >5% viewport visibility, when the
* user manually scrolls (wheel event detected), or after MAX_SCROLL_ATTEMPTS
* (10) retries at 350 ms intervals. A 10-second absolute timeout disconnects
* the observer as a safety fallback.
* Scrolling is vertical (element centered); the horizontal axis is moved only
* when the node lies outside the viewport width.
* The inner center_with_scroll_to helper computes absolute scroll coordinates
* to center the element, used in preference to scrollIntoView for finer
* positioning control.
* @param {HTMLElement} node_to_scroll - The element to scroll into view.
* @returns {void}
*/
const scroll_to_node = (node_to_scroll) => {

	let scrolled = false

	// fully visible check. A node that already fits the viewport height does
	// not need any scroll (prevents unnecessary page movement).
	const is_fully_visible = (el) => {
		const rect = el.getBoundingClientRect()
		if (rect.height <= 0) {
			return false
		}
		return rect.top >= 0 && rect.bottom <= window.innerHeight
	}

	const center_with_scroll_to = (el, offsetTop = 0)=> {
		const rect   = el.getBoundingClientRect(); // position relative to viewport
		const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
		const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

		// Desired Y coordinate of the element’s top edge after scrolling
		const desiredY = scrollTop + rect.top - (window.innerHeight / 2) + (rect.height / 2) + offsetTop;

		// Desired X coordinate – moved ONLY when the node is outside the
		// viewport width, to prevent unnecessary horizontal shifts.
		const out_of_view_x = (rect.left < 0 || rect.right > window.innerWidth)
		const desiredX = out_of_view_x
			? scrollLeft + rect.left - (window.innerWidth / 2) + (rect.width / 2)
			: scrollLeft

		window.scrollTo({
			top:   desiredY,
			left:  desiredX,
			behavior: 'smooth'   // optional
		});

		scrolled = true
	}

	// user wheel event
	// To prevent to change the early user scroll, check for user wheel event
	// before to try it programmatically (less intrusive behavior)
	let user_scroll = false
	const wheel_handler = () => {
		user_scroll = true
	}
	window.addEventListener('wheel', wheel_handler, { passive: true });

	// cleanup helper. The wheel listener is removed in EVERY exit path
	// (success, user scroll, max attempts, timeout, already-visible).
	const cleanup_wheel = () => {
		window.removeEventListener('wheel', wheel_handler, { passive: true });
	}

	const scroll_node = () => {
		if (user_scroll) {
			cleanup_wheel()
			return
		}
		// node_to_scroll.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" })
		center_with_scroll_to(node_to_scroll, 0)
	}

	let scroll_interval = null;
	let scroll_attempts = 0;
	const MAX_SCROLL_ATTEMPTS = 10; // Prevent infinite scrolling

	// already fully visible case: no scroll needed now. A single delayed
	// verification protects against late layout shifts (slow tree parses)
	// moving the node out of sight: it scrolls only when really needed
	// instead of the previous unconditional re-centering.
	if (is_fully_visible(node_to_scroll)) {
		cleanup_wheel()
		setTimeout(() => {
			if (!is_fully_visible(node_to_scroll)) {
				center_with_scroll_to(node_to_scroll, 0)
			}
		}, 2000)
		return
	}

	// Create observer
	const observer = new IntersectionObserver((entries) => {
		entries.forEach(entry => {

			if (entry.isIntersecting) {
				// console.error('Element is visible:', entry.target);

				const visibilityPercentage = Math.round(entry.intersectionRatio * 100);
				if (visibilityPercentage > 5) {
					// Success - clean up everything
					observer.disconnect();
					if (scroll_interval) {
						clearInterval(scroll_interval);
						scroll_interval = null;
					}
					cleanup_wheel()
				}
			} else {
				// console.log('Element is not visible:', entry.target);

				// Clear any existing interval
				if (scroll_interval) {
					clearInterval(scroll_interval);
				}

				// Initial scroll attempt
				scroll_node();
				scroll_attempts = 1;

				// Set up interval with retry limit
				const do_scroll = () => {
					if (scroll_attempts >= MAX_SCROLL_ATTEMPTS) {
						console.warn('Max scroll attempts reached, giving up');
						clearInterval(scroll_interval);
						observer.disconnect();
						cleanup_wheel()
						return;
					}

					console.log(`Scrolling attempt ${scroll_attempts + 1}`);
					scroll_attempts++;
					dd_request_idle_callback(scroll_node);
				};

				scroll_interval = setInterval(do_scroll, 350);
			}
		});
	}, {
		threshold: [0, 0.05, 0.1] // Check at 0%, 5%, and 10% visibility
	})

	observer.observe(node_to_scroll);

	// Cleanup timeout as fallback
	setTimeout(() => {
		if (observer) {
			observer.disconnect();
		}
		if (scroll_interval) {
			clearInterval(scroll_interval);
		}
		cleanup_wheel()
		if (!scrolled) {
			console.log('Scroll operation timed out after 10 seconds');
		}
	}, 10000);
}//end scroll_to_node



/**
* SAVE_ORDER
* Reorders this node among its siblings to a new 1-based position and
* persists the new order to the server via dd_ts_api (action: 'save_order').
* Operates in five steps:
*   1. Validates the new position (no-op when unchanged or NaN).
*   2. Finds the current node in the parent's ar_children_data array.
*   3. Moves it in-place using splice to derive the new ordered locator list.
*   4. Updates virtual_order on all matching live instances immediately
*      (optimistic sync — no server confirmation required for the visual).
*   5. Sends the full ordered locator array to the server.
* (!) The @param annotation listed 'mixed new_value' which is a leftover from
* an earlier signature; only value is accepted. Flagged; not changed.
* @param {number|string} value - Target 1-based position for this node.
* @returns {Promise<boolean>} false on validation failure; true on success
*   (even if the server call throws — error is caught and notified).
*/
ts_object.prototype.save_order = async function( value ) {

	const self = this
	const new_value = parseInt( value )
	const old_value = parseInt( self.virtual_order )

	// 1. Validation: check if change is needed
	if (isNaN(new_value) || new_value === old_value) {
		if (SHOW_DEBUG) console.log("[ts_object.save_order] Value unchanged or invalid. Ignoring save_order.");
		return false
	}

	const parent_instance = self.caller
	if (!parent_instance) {
		console.error("[ts_object.save_order] Missing parent instance (caller)");
		return false
	}

	// 2. Sibling Discovery: Use parent's ar_children_data as the source of truth
	// This ensures we have a complete and authoritative list of siblings.
	const ar_children_data = parent_instance.children_data?.ar_children_data || []

	// Find the current instance's index in the data array
	const current_data_index = ar_children_data.findIndex(item =>
		item.section_tipo === self.section_tipo && same_section_id(item.section_id, self.section_id)
	)

	if (current_data_index === -1) {
		console.error("[ts_object.save_order] Self not found in parent's children data. Aborting.", {
			section_tipo : self.section_tipo,
			section_id   : self.section_id
		})
		return false
	}

	// 3. Reordering Logic: Perform the move directly on the authoritative data array
	const total_siblings = ar_children_data.length
	const target_index   = Math.max(0, Math.min(new_value - 1, total_siblings - 1))

	if (current_data_index === target_index) {
		if (SHOW_DEBUG) console.log("[ts_object.save_order] Target index matches current index. Ignoring action.");
		return false
	}

	// Move the item in ar_children_data
	const [moved_item] = ar_children_data.splice(current_data_index, 1)
	ar_children_data.splice(target_index, 0, moved_item)

	// Build locators for the API based on the final data order
	const ar_locators = ar_children_data.map(item => ({
		section_tipo : item.section_tipo,
		section_id	 : item.section_id
	}))

	// 4. Runtime Synchronization: Update live instances virtual_order
	// Identify all cached ts_object instances to update their order
	const instances_pool = get_all_instances().filter(inst => inst.model === 'ts_object')

	ar_locators.forEach((loc, i) => {
		const found = instances_pool.find(inst =>
			inst.section_tipo === loc.section_tipo && same_section_id(inst.section_id, loc.section_id)
		)
		if (found) {
			found.virtual_order = i + 1
		}
	})

	// 5. Persistence: API Request
	const rqo = {
		dd_api			: 'dd_ts_api',
		prevent_lock	: true,
		action			: 'save_order',
		source			: {
			section_tipo		: self.section_tipo,
			ar_locators			: ar_locators,
			parent_section_tipo	: parent_instance.section_tipo,
			parent_section_id	: parent_instance.section_id
		}
	}

	try {
		const api_response = await data_manager.request({ body : rqo })

		if (SHOW_DEBUG) console.log("[ts_object.save_order] api_response", api_response)

		if (!response_data(api_response)) {
			throw new Error(request_failed(api_response) ? error_text(api_response.error) : 'Error on save order response')
		}

		// Success notification
		event_manager.publish('notification', {
			msg			: get_label.saved || 'Order updated',
			type		: 'success',
			remove_time	: 1200
		})

	} catch (error) {
		console.error('[ts_object.save_order] Persisting order failed:', error)
		event_manager.publish('notification', {
			msg			: `Failed to save new order: ${error.message}`,
			type		: 'error',
			remove_time	: 10000
		})
	}

	return true
}//end save_order



/**
* TOGGLE_ND
* Toggles the visibility of the nd_container (non-descriptor children panel).
* If currently visible: hides it and returns.
* If hidden and children are already in the DOM: shows it and returns.
* If hidden and no children yet: fetches children data from the API,
* renders them into children_container, then shows nd_container.
* (!) @return annotation in original said 'bool', but the function is async
* and the actual contract is Promise<boolean>. Corrected here.
* @param {HTMLElement} button_obj - The ND toggle button element (unused in body
*   after refactor; nd_container is read from self directly).
* @returns {Promise<boolean>} true on success; false when nd_container is absent
*   or a children fetch/render error occurs.
*/
ts_object.prototype.toggle_nd = async function(button_obj) {

	const self = this

	// nd_container
	// const nd_container = self.get_my_parent_container(button_obj, 'nd_container')
	const nd_container = self.nd_container
	if (!nd_container) {
		if(SHOW_DEBUG===true) {
			console.log("[ts_object.toggle_nd] Error on locate nd_container from button_obj",button_obj);
		}
		return false
	}

	// If it is not already hidden, hide it.
	if (!nd_container.classList.contains('hide')) {

		// Hide showed nd_container
		nd_container.classList.add('hide')

		return true;
	}

	// If already is loaded (contains nodes), just show it.
	// const children_container = self.get_my_parent_container(button_obj, 'children_container')
	const children_container = self.children_container
	const has_nodes = children_container.childNodes.length > 0
	if (has_nodes) {
		nd_container.classList.remove('hide')
		return true;
	}

	// Load children and show the container
	try {

		const children_data = await self.get_children_data({
			pagination	: null,
			children	: null,
			cache		: true
		})

		if (!children_data) {
			// error case
			console.warn("[toggle_nd] Error, children_data is null");
			return false
		}

		await self.render_children({
			clean_children_container	: true, // bool clean_children_container
			children_data				: children_data
		})

		// Show hidden nd_container
		nd_container.classList.remove('hide')

		return true;

	} catch (error) {
		console.error("[toggle_nd] An error occurred while loading or rendering children:", error);
		return false;
	}
}//end toggle_nd



/**
* IS_ROOT
* Returns true when the given tipo is a known root section tipo.
* Root sections are the top-level containers of the hierarchy or ontology
* tree ('hierarchy1' for the Thesaurus, 'ontology35' for the Ontology).
* (!) The list is hardcoded; adding a new thesaurus root requires updating
* ar_root_tipo here.
* @param {string} tipo - The section tipo to check (e.g. 'hierarchy1').
* @returns {boolean} True when tipo is in the known root-tipo list.
*/
ts_object.prototype.is_root = function (tipo) {

	const ar_root_tipo = [
		'hierarchy1',
		'ontology35'
	]

	return ar_root_tipo.includes(tipo)
}//end is_root



// @license-end
