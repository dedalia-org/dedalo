// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* COMPONENT_SECURITY_ACCESS
* Client-side logic for the Dédalo access-control component (ontology tipo `dd774`).
*
* Responsibilities:
* - Holds the permission matrix for a single security profile in `this.filled_value` —
*   a flat array of `{tipo, section_tipo, value}` objects covering every reachable
*   ontology element (areas, sections, components, buttons, relation lists, …).
* - Builds `filled_value` from `this.data.entries` + `this.data.datalist` on `build()`,
*   defaulting to `value: 0` (no access) for any datalist node not found in the stored
*   entries — this ensures the edit UI can render radio buttons for every node even when
*   the DB row is absent (zero is never persisted; see `save_changes()`).
* - Propagates permission changes upward through the tree: when a leaf changes,
*   `update_parents_radio_butons()` walks up via `ar_parent` and sets each ancestor's
*   radio button to the shared value (or null when siblings disagree).
* - Delegates rendering to the per-mode render sub-modules:
*     - `render_edit_component_security_access`  → edit / line / print (tree UI with radio buttons)
*     - `render_list_component_security_access`  → list / tm (intentionally austere placeholder)
*     - `render_search_component_security_access` → search (placeholder only)
* - Offloads expensive tree walks (`get_children`, `get_parents`) to
*   `worker_security_access.js` to keep the UI thread responsive on large ontologies.
* - Inherits the full component lifecycle (init → build → render → save → destroy) from
*   `component_common` and `common`.
*
* Permission levels (stored as integers in `value`):
*   0 – no access (absent from persisted data)
*   1 – read-only
*   2 – read and edit
*   3 – admin / full control
*
* Data shape (`this.data.entries`): flat array of permission objects
*   `{ id: number, tipo: string, section_tipo: string, value: number }`
* When `tipo === section_tipo` the row describes a section (or area) itself;
* otherwise it describes a leaf element belonging to that section.
*
* Datalist shape (`this.data.datalist`): flat array of ontology-tree nodes (derived,
* not stored — computed server-side and cached as `cache_tree_<lang>.php`). Each item:
*   `{ tipo: string, section_tipo: string, model: string, label: string,
*      parent: string, ar_parent: string[] }`
* `ar_parent` is the full ancestor chain needed for upward propagation without re-walking.
*
* `filled_value` (instance property, not persisted): built in `build()` as the union of
* `data.entries` and all `data.datalist` nodes, with defaulted-to-zero entries filling
* the gaps. This is the live permission map that `update_value()` mutates and
* `save_changes()` reads before stripping zeros and persisting.
*
* Events emitted (via `event_manager`):
*   `update_item_value_{id}_{tipo}_{section_tipo}` — broadcast when a permission row
*     is changed, so the view can refresh that node's radio button.
*   `update_area_radio_{id}_{tipo}_{section_tipo}` — broadcast for each ancestor node
*     when upward propagation completes.
*
* @see component_common  Generic lifecycle, save, change_value, mode-switch.
* @see render_edit_component_security_access   Edit-mode tree view dispatch.
* @see render_list_component_security_access   List / TM view dispatch.
* @see render_search_component_security_access  Search placeholder view.
* @see worker_security_access.js  Web-worker for recursive get_children / get_parents.
* @see docs/core/components/component_security_access.md  Full data-model reference.
*/

// imports
	import {common} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {render_edit_component_security_access} from './render_edit_component_security_access.js'
	import {render_list_component_security_access} from './render_list_component_security_access.js'
	import {render_search_component_security_access} from './render_search_component_security_access.js'
	import {response_data} from '../../common/js/api_error.js'



/**
* COMPONENT_SECURITY_ACCESS
* Constructor. Declares all instance properties used throughout the lifecycle.
* All properties are left undefined here; `component_common.init()` populates
* them from the options object passed at mount time.
*
* Additional property introduced by this component:
* - `worker_path` {string} — resolved path to `worker_security_access.js`, set during
*   `init()`. The worker is created on demand by the render layer for recursive
*   `get_children` / `get_parents` calls.
* - `filled_value` {Array} — NOT declared here; built by `build()` and updated by
*   `update_value()`. Stores the fully materialized permission matrix with zero-value
*   defaults, used as the live working copy for saves and propagation.
*/
export const component_security_access = function() {

	this.id

	// element properties declare
	this.model
	this.tipo
	this.section_tipo
	this.section_id
	this.mode
	this.lang

	this.section_lang
	this.context
	this.data
	this.parent
	this.node

	this.tools

	this.worker_path

	// active tree-filter query ('' = no filter). Set by the view's tree filter and
	// read by the renderers to paint branches open and eager; never persisted.
	this.filter_query = ''

	// the matching ENTRIES of that query (the datalist objects, by reference). The
	// renderers mark them with `.match`; ancestors kept for the path are not here.
	this.filter_matches = null

	// get_children() memo for the full datalist ('' → built on first call, dropped
	// by build()). The filtered tree paints every area open, so without it each
	// paint re-scanned the whole ~32k-entry datalist once per area.
	this.children_memo = null
}//end component_security_access



/**
* COMMON FUNCTIONS
* Extend instance with shared prototype methods from common / render modules.
* Individual prototype assignments are documented at their source definitions;
* the grouping below shows the logical role each borrowed method fulfills here.
*/
// prototypes assign
	// lifecycle
	component_security_access.prototype.init				= component_common.prototype.init
	component_security_access.prototype.build				= component_common.prototype.build
	component_security_access.prototype.render				= common.prototype.render
	component_security_access.prototype.refresh				= common.prototype.refresh
	component_security_access.prototype.destroy				= common.prototype.destroy

	// change data
	component_security_access.prototype.save				= component_common.prototype.save
	component_security_access.prototype.update_data_value	= component_common.prototype.update_data_value
	component_security_access.prototype.update_datum		= component_common.prototype.update_datum
	component_security_access.prototype.change_value		= component_common.prototype.change_value
	component_security_access.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_security_access.prototype.build_dd_request	= common.prototype.build_dd_request

	// render — a Time Machine cell reuses the list renderer because the permission matrix is displayed
	// identically in Time Machine view (values shown read-only; no tree interaction)
	component_security_access.prototype.list				= render_list_component_security_access.prototype.list
	component_security_access.prototype.edit				= render_edit_component_security_access.prototype.edit
	component_security_access.prototype.search				= render_search_component_security_access.prototype.search

	component_security_access.prototype.change_mode			= component_common.prototype.change_mode



/**
* INIT
* Initialises the component instance and registers the web-worker path used
* for expensive recursive tree operations (get_children, get_parents).
*
* Delegates all standard bootstrapping (option assignment, context/data fetch,
* instance registration) to `component_common.prototype.init`. After that
* completes, this override:
*   1. Checks that `window.Worker` is available — a missing Worker API means
*      propagation across large permission trees will be slow (synchronous).
*   2. Stores `worker_path` so the render layer can create worker instances on
*      demand without hard-coding the path.
*
* (!) The `throw` that would have blocked startup on missing Worker support is
* intentionally commented out; the component degrades gracefully to synchronous
* tree-walk methods instead of failing hard.
*
* @param {Object} options - Standard component init options (tipo, section_tipo,
*   section_id, mode, lang, parent, etc.) forwarded verbatim to component_common.
* @returns {Promise<boolean>} Resolves to `true` on success, `false` on duplicate init.
*/
component_security_access.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await component_common.prototype.init.call(self, options);

	// check worker support. Manages get_children and get_parents expensive recursive functions mainly
		if(!window.Worker) {
			console.error('Your browser does not support web workers..');
			// throw new Error('Unable to continue. workers are needed');
		}
		self.worker_path = '../component_security_access/js/worker_security_access.js'


	return common_init
}//end init



/**
* BUILD
* Materialises the full permission matrix (`this.filled_value`) from the raw
* server response, then delegates any remaining generic setup to component_common.
*
* Why a filled_value is needed:
*   The server only stores rows whose `value > 0` (zero means "no access" and is
*   never persisted). The UI, however, must render a radio button for *every* node
*   in the datalist, including those with no stored permission. `filled_value` is
*   therefore the union of stored entries and the full datalist, with absent entries
*   defaulted to `{ tipo, section_tipo, value: 0 }`. This lets the edit tree, the
*   propagation logic, and `save_changes()` all work against a single coherent array.
*
* Performance note:
*   The previous O(n²) implementation (commented out below) scanned `data.entries`
*   linearly for each datalist item. The current implementation indexes `data.entries`
*   into a `Map` keyed by `"tipo-section_tipo"` first, reducing the overall cost to
*   O(n + m) where n = entries.length and m = datalist.length. On large ontologies
*   the datalist can contain several thousand nodes, making this difference material.
*
* @param {Object} options - Build options forwarded verbatim to component_common.
* @returns {Promise<boolean>} Resolves to the value returned by component_common.build.
*/
component_security_access.prototype.build = async function(options) {
	const t0 = performance.now()

	const self = this

	// call the generic common method
		const common_build = await component_common.prototype.build.call(self, options);

	// fill value zero on data.
	// Note that items with value 0 will not be saved in DDBB, but they will need to be added to data
	// to be processed by client interface (to propagate values)
		// const filled_value		= []
		// const data				= self.data || {}
		// const value				= data.entries || []
		// const datalist			= data.datalist || []
		// const datalist_length	= datalist.length
		// for (let i = datalist_length - 1; i >= 0; i--) {

		// 	const item	= data.datalist[i]
		// 	const found	= value.find(el =>
		// 		el.tipo===item.tipo &&
		// 		el.section_tipo===item.section_tipo
		// 	)
		// 	if (found) {
		// 		filled_value.push(found)
		// 	}else{
		// 		filled_value.push({
		// 			tipo			: item.tipo,
		// 			section_tipo	: item.section_tipo,
		// 			value			: 0
		// 		})
		// 	}
		// }
		// // replace value
		// self.filled_value = filled_value

		// optimized version using map
		const data		= self.data || {};
		const datalist	= data.datalist || [];
		// index stored entries by composite key "tipo-section_tipo" for O(1) lookup
		const value_map	= new Map(data.entries?.map(item => [`${item.tipo}-${item.section_tipo}`, item]) || []);

		// produce filled_value: one entry per datalist node, using the stored row when
		// present or a synthetic zero-value stub when not
		self.filled_value = datalist.map(item => {
			const key = `${item.tipo}-${item.section_tipo}`;
			return value_map.has(key) ? value_map.get(key) : { tipo: item.tipo, section_tipo: item.section_tipo, value: 0 };
		});

	// the payload may be fresh on every build: drop the get_children memo
		self.children_memo = null

	// debug
		console.log(`__Time to build ${self.model} ${Math.round(performance.now()-t0)} ms`);


	return common_build
}//end build



/**
* UPDATE_VALUE
* Sets the permission level for a single ontology node in the live permission matrix
* (`self.filled_value`) and notifies the view layer so it can refresh that node's
* radio button without a full re-render.
*
* Contract:
*   - `item` MUST be a datalist node object (see data shape below). If it is falsy
*     (e.g. called before the datalist has loaded) the function logs an error and
*     returns early. (!) Note: the early-return references `value` before it is
*     declared — this is a pre-existing bug; do not reproduce.
*   - `input_value` is coerced to an integer via `parseInt`. Passing a string like
*     "2" is therefore valid. Values outside 0–3 are not validated here; the render
*     layer is responsible for only emitting legal permission levels.
*   - `self.filled_value` is mutated in place: the found entry's `.value` is updated
*     directly on the shallow copy. If the node is absent from `filled_value`
*     (should not occur after `build()`, but guarded anyway) a new stub is appended.
*   - The `parent` field is intentionally commented out of the new stub — only
*     `tipo`, `section_tipo`, and `value` are persisted in the DB.
*
* Side effects:
*   Publishes the event `update_item_value_{self.id}_{item.tipo}_{item.section_tipo}`
*   via `event_manager`. The edit view subscribes to this topic per rendered node
*   to re-apply the CSS permission-level class without re-rendering the whole tree.
*
* @param {Object} item - Datalist node identifying the ontology element to update.
*   Expected shape:
*   ```json
*   {
*     "label": "Descripción",
*     "model": "section_group",
*     "parent": "mht39",
*     "tipo": "mht55",
*     "section_tipo": "mht5"
*   }
*   ```
* @param {number|string} input_value - New permission level (0–3); coerced to int.
* @returns {Array} The updated `filled_value` array.
*   Each element has shape: `{ tipo: string, section_tipo: string, value: number }`.
*/
component_security_access.prototype.update_value = function(item, input_value) {

	const self = this

	// value . Copy of current data.entries
		const value = self.filled_value
			? [...self.filled_value]
			: []

	// item check
		if (!item) {
			console.error("Ignored undefined item:", input_value);
			return value
		}

	// find if already exists
		const found = value.find(el => el.tipo===item.tipo && el.section_tipo===item.section_tipo)
		if (found) {
			// update
			found.value = parseInt(input_value)
		}else{
			// add
			const object_value = {
				tipo			: item.tipo,
				section_tipo	: item.section_tipo,
				// parent		: item.parent,
				value			: parseInt(input_value)
			}
			value.push(object_value)
		}

	// fix updated changed_value
		self.filled_value = value

	// event. publish update_item_value_xx event on change data.entries
		event_manager.publish(
			'update_item_value_' + self.id + '_' + item.tipo + '_' + item.section_tipo,
			input_value
		)


	return value
}//end update_value



/**
* GET_PARENTS
* Returns all direct and indirect ancestors of a datalist node by matching
* `el.tipo` against the node's pre-computed `ar_parent` array.
*
* This is a lookup function — not a recursive walk. The server pre-computes the
* full ancestor chain for each node and stores it in `ar_parent` (e.g.
* `["rsc197", "rsc76"]`). This method simply filters the flat datalist to the
* subset of nodes whose `tipo` appears in that chain. The result therefore
* includes *all* ancestors at once (direct parent, grandparent, …), not just the
* immediate parent.
*
* Used by `update_parents_radio_butons()` to walk upward after a permission change.
* The render layer may also delegate this call to `worker_security_access.js`
* to keep the UI thread free on large datalists.
*
* @param {Object} item - Datalist node whose ancestors are needed.
*   Must have an `ar_parent` array property (populated by the server).
* @param {Array|undefined} datalist - Optional override; defaults to `self.data.datalist`.
* @returns {Array} Subset of datalist nodes that are ancestors of `item`.
*   Order reflects datalist order, not tree depth order.
*/
component_security_access.prototype.get_parents = function(item, datalist) {

	const self = this

	const current_datalist = datalist || self.data.datalist

	const parents = current_datalist.filter(el => item.ar_parent?.includes(el.tipo))


	return parents;
}//end get_parents



/**
* GET_CHILDREN
* Returns all direct and indirect descendants of a datalist node by checking
* whether `item.tipo` appears in each candidate's `ar_parent` array.
*
* The inverse of `get_parents`: while `get_parents` reads the node's own
* `ar_parent` to find ancestors, this method scans every node in the datalist
* and returns those that declare `item.tipo` anywhere in their own ancestor
* chain. The result therefore includes *all* descendants (children,
* grandchildren, …) in a single flat array — not just immediate children.
*
* Used in `update_parents_radio_butons()` to determine whether all siblings
* under a parent share the same permission level (so the parent's radio button
* can be set or cleared). The render layer may offload this call to the web
* worker (`worker_security_access.js`) on large datalists.
*
* Calls that use the FULL datalist (no override) are memoized on the instance:
* the tree filter paints every area open, so one paint used to run this ~32k-entry
* scan once per area (measured ~13 ms each). `data.datalist` is immutable for the
* instance's life, and `build()` drops the memo when it is rebuilt.
*
* @param {Object} item - Datalist node whose descendants are needed.
*   Must be a valid datalist entry with a `tipo` property.
* @param {Array|undefined} datalist - Optional override; defaults to `self.data.datalist`.
* @returns {Array} All datalist nodes for which `item.tipo` appears in their `ar_parent`.
*   Order reflects datalist order.
*/
component_security_access.prototype.get_children = function(item, datalist) {

	const self = this

	const current_datalist = datalist || self.data.datalist

	// memo, full list only (an override list is the caller's own business)
		const memoized = datalist===undefined
		if (memoized && self.children_memo?.has(item.tipo)) {
			return self.children_memo.get(item.tipo)
		}

	const children = current_datalist.filter(el => el.ar_parent?.includes(item.tipo))

	if (memoized) {
		if (!self.children_memo) {
			self.children_memo = new Map()
		}
		self.children_memo.set(item.tipo, children)
	}


	return children
}//end get_children



/**
* UPDATE_PARENTS_RADIO_BUTONS
* Propagates a permission-level change upward through the ontology tree,
* updating the radio-button display of every ancestor of the changed node.
*
* The propagation rule: an ancestor's radio button is set to `input_value` only
* when **all of its non-section leaf children** share that same permission level
* in `self.filled_value`. If any child disagrees, the ancestor's radio is set to
* `null` (indeterminate / mixed state). Once the first differing sibling is found
* (`diff_value = true`) the same `null` signal is published to all remaining
* ancestors without re-examining their children.
*
* Why sections/areas are excluded from the sibling check:
*   Nodes where `tipo === section_tipo` are the section (or area) itself — they
*   aggregate their children's permissions rather than carrying an independent
*   permission. Including them in the child scan would create a circular dependency
*   (the parent's computed value would be compared against itself). They are
*   therefore `continue`d in the inner loop.
*
* Side effects:
*   For each ancestor, publishes
*   `update_area_radio_{self.id}_{parent.tipo}_{parent.section_tipo}` via
*   `event_manager`. The edit view subscribes per tree node to re-apply the
*   appropriate CSS class (val_0 / val_1 / val_2 / val_3 / indeterminate).
*
* (!) Typo in method name: "butons" should be "buttons". Do not rename — the
* render layer and worker call this method by its current name.
*
* @param {Object} item - The datalist node whose permission just changed.
*   Shape: `{ tipo, section_tipo, model, label, parent, ar_parent }`.
* @param {number} input_value - The new integer permission level (0–3) just applied.
* @returns {boolean} `true` if any sibling had a different value (mixed state was
*   detected); `false` if all siblings agreed and the value was propagated uniformly.
*/
component_security_access.prototype.update_parents_radio_butons = function(item, input_value) {

	const self = this

	// parents (recursive)
	const parents = self.get_parents(item)

	let diff_value = false
	// set the data of the parents and change the DOM node with update_value event
	const parents_length = parents.length
	for (let i = 0; i < parents_length; i++) {

		const current_parent = parents[i]

		// different value case
			if(diff_value===false) {

				// check values of every child finding a different value from last value found
				const current_children			= self.get_children(current_parent)
				const current_children_length	= current_children.length
				for (let k = current_children_length - 1; k >= 0; k--) {

					const child = current_children[k]

					// exclude sections and areas: when tipo===section_tipo the node is the section
					// (or area) itself — it aggregates children's permissions rather than carrying
					// its own, so it must not participate in the sibling-agreement check
					if(child.tipo===child.section_tipo) {
						continue
					}

					const data_found = self.filled_value.find(el => el.tipo===child.tipo && el.section_tipo===child.section_tipo)
					if (!data_found) {
						diff_value = true
						break
					}
					if(data_found.value!==input_value) {
						diff_value = true
						break
					}
				}
			}//end if(diff_value===false)

		// value_to_propagete
			const value_to_propagete = (diff_value===false)
				? input_value
				: null

		// parent target value update
			event_manager.publish(
				'update_area_radio_' + self.id + '_' + current_parent.tipo + '_' + current_parent.section_tipo,
				value_to_propagete
			)
	}//end for (let i = 0; i < parents_length; i++)


	return diff_value
}//end update_parents_radio_butons



/**
* SAVE_CHANGES
* Persists the current permission matrix to the server, stripping zero-value
* entries first (zero = "no access" is the implicit default and is never stored).
*
* Why `set_data` (not `insert` / `update`):
*   Standard component mutations use `insert` or `update` to target a single datum
*   by its `id`. `component_security_access` treats its entire entry array as one
*   atomic value: any save replaces the whole stored array wholesale. The special
*   action `set_data` instructs the server-side handler to overwrite the stored
*   datum in one operation rather than merging individual rows.
*
* The `refresh: false` flag prevents the component from re-fetching and re-rendering
* after the save — the UI already reflects the user's changes, so an immediate
* refresh would be redundant and would reset the tree's scroll/expansion state.
*
* (!) `Object.freeze()` on `changed_data[0]` prevents accidental mutation of the
* payload between this call and the async API dispatch. This is intentional.
*
* @returns {Promise<boolean|Object>} Resolves to the value returned by `change_value()`:
*   `true` on success (no-op if nothing changed), or the raw API response object
*   when the server processed the request.
*/
component_security_access.prototype.save_changes = async function() {

	const self = this

	// rebuild value removing empty zero values
		const clean_changed_value	= []
		const value_length			= self.filled_value.length
		for (let i = 0; i < value_length; i++) {
			const value_item = self.filled_value[i]
			if (value_item.value>0) {
				clean_changed_value.push(value_item)
			}
		}

	// changed_data build
	// (!) Note that action is 'set_data' instead 'insert' or 'update', to save whole array data as raw value
		const changed_data = [Object.freeze({
			action	: 'set_data',
			value	: clean_changed_value
		})]

	// change_value to save
		const result = self.change_value({
			changed_data	: changed_data,
			refresh			: false
		})


	return result
}//end save_changes



/**
* GET_CHANGES_DATA
* Fetches and parses a schema-changes diff file from the server so it can be
* displayed in the `changes_container` panel of the security-access edit view.
*
* Context: the edit UI can display a side panel that lists pending ontology
* changes from a schema migration file (e.g. new sections added, tipos renamed).
* This method delegates parsing to the `dd_area_maintenance_api` so the raw file
* is never sent to the client; the server returns a structured diff object ready
* for rendering.
*
* The request is dispatched through a web worker (`use_worker: true`) to avoid
* blocking the main thread during I/O-heavy file parsing on large change sets.
*
* @param {string} filename - Name of the schema-changes file to parse (relative to
*   the path known by `dd_area_maintenance_api`).
* @returns {Promise<boolean|Object>} Resolves to `api_response.result`:
*   the parsed diff object returned by `parse_simple_schema_changes_files()`,
*   or `false` if the API reports an error.
*/
component_security_access.prototype.get_changes_data = async function(filename) {

	// data_manager
	const api_response = await data_manager.request({
		use_worker	: true,
		body		: {
			dd_api	: 'dd_area_maintenance_api',
			action	: 'parse_simple_schema_changes_files',
			options	: {
				filename : filename
			}
		}
	})
	if(SHOW_DEBUG===true) {
		console.log('get_changes_data api_response:', api_response);
	}


	return response_data(api_response)
}//end get_changes_data



// @license-end
