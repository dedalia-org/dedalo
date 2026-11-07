// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, SHOW_DEBUG, SHOW_DEVELOPER, Promise */
/*eslint no-undef: "error"*/



/**
* COMPONENT_COMMON
* Prototype mixin that provides the shared lifecycle, data, and event methods for
* every Dédalo component instance (component_input_text, component_select, etc.).
*
* This module does NOT extend `common.js` — it replaces or wraps several of its
* prototype methods with component-specific behaviour. The public prototype chain is:
*
*   ComponentXxx → component_common.prototype → common.prototype
*
* Lifecycle order for every component instance:
*   init(options) → build(autoload) → render({render_level}) →
*   [change_value / save cycles] → refresh() → destroy()
*
* Status state machine (self.status):
*   'initializing' → 'initialized' → 'building' → 'built'
*   → 'rendering' → 'rendered' → 'changing' → 'destroyed'
*
* Key data shapes:
*   datum  : { data: Array<DataItem>, context: Array<ContextItem> }
*             Shared with the parent section; portals have their own datum.
*   data   : DataItem — { tipo, section_tipo, section_id, mode, lang,
*                          entries: Array<*>, changed_data: Array<ChangedDataItem> }
*   db_data: DataItem — snapshot of `data` as last returned by the server.
*                       Used by set_changed_data / save to detect genuine edits.
*
* Exported named functions (module-level, not on the prototype):
*   init_events_subscription — wires ontology-driven observer events once per build.
*   check_unsaved_data       — prompt/auto-save guard for navigation events.
*   save_unsaved_components  — sweep all instances (and orphans) and flush pending changed_data.
*   orphan_unsaved_instance  — keep a dirty instance alive after its row is torn down.
*   deactivate_components    — click-away handler that deactivates the active component.
*   is_empty                 — check whether a component instance has no user data.
*   activate_edit_in_list    — unified inline-or-modal edit entry point for list views.
*
* Edit-safety primitives (contract: engineering/wire_contract/WC-2026-10-30-section-record-row-box.md,
* addendum "edit-safety primitives") — what the row window needs to know that a
* component has finished writing:
*   saving_promise        — present iff a save is pending (after the guard).
*   change_value_promise  — present iff a change_value call is running.
*   commit_seq            — advances at the entry of change_value and
*                           set_changed_data: "a value was handed over".
*   settle()              — wait for all of the above, flush what is left;
*                           true when no unsaved registration remains.
*   failed_changed_data   — a FAILED save registers the instance as unsaved and
*                           keeps what it did not persist here (and in
*                           data.changed_data); the next save of the instance
*                           sends it first, and only a save that carried it
*                           (or a supersession) clears it.
*   SUPERSESSION          — per ITEM target, by hand-over order (edit stamps):
*                           a save retires the OLDER pending items of the same
*                           field (id_base + lang) its items overlap (an
*                           orphan's, a sibling's failed ones), and does not
*                           send its own items a NEWER pending item overlaps.
*                           Items on other targets are never touched
*                           (resolve_supersession).
*
* Re-exported from dataframe.js (backwards-compatibility shim):
*   get_dataframe, delete_dataframe, attach_item_dataframe
*/



// imports
	import { clone, dd_console, is_equal } from '../../common/js/utils/index.js'
	import { event_manager } from '../../common/js/event_manager.js'
	import { set_before_unload, register_unsaved_instance, deregister_unsaved_instance, reset_unsaved_data, dd_request_idle_callback, get_unsaved_instances, orphaned_unsaved, claim_orphaned_unsaved_writers } from '../../common/js/events.js'
	import { data_manager } from '../../common/js/data_manager.js'
	import { get_instance, get_all_instances, get_instance_by_id, delete_instance } from '../../common/js/instances.js'
	import { set_context_vars, create_source, same_occurrence_on_merge, root_caller_chains } from '../../common/js/common.js'
	import { events_subscription } from './events_subscription.js'
	import { ui } from '../../common/js/ui.js'
	import {request_failed, normalize_transport_error, response_data} from '../../common/js/api_error.js'
	import { handle_api_error, is_page_identity_revoked } from '../../common/js/error_dispatch.js'



// orphaned_unsaved_writers. The once-only writer capability of events.js
// orphaned_unsaved (claim_orphaned_unsaved_writers): claimed HERE, at load, so
// no other module can obtain it — a second claim throws, in either order.
	const orphaned_unsaved_writers = claim_orphaned_unsaved_writers()



/**
* COMPONENT_COMMON
* Base constructor for the component_common mixin.
* Every concrete component class (component_input_text, etc.) inherits from this
* via prototype chaining: `ComponentXxx.prototype = Object.create(component_common.prototype)`.
* The constructor itself is a no-op; all setup happens in `init()`.
*/
export const component_common = function(){

	return true
}//end component_common



/**
* INIT
* Seeds all well-known instance properties from `options` and attaches shared
* event subscriptions. Must be called exactly once per instance.
*
* Acts as the component-specific replacement for common.prototype.init(): it
* sets component-only properties (mode, lang, column_id, standalone, etc.) that
* the base common.init() does not cover.
*
* (!) A second call on the same instance is treated as a programming error: it
* logs a console.error and — in debug mode — fires alert(). Always guard creation
* paths so init() runs only once.
*
* Subscription order matters: events_subscription(self) wires the shared
* sync_data / hilite handlers first, then the concrete component's own
* self.events_subscription() (if defined) adds model-specific subscriptions.
* init_events_subscribed is deliberately left false here; it is flipped to true
* inside init_events_subscription(), called during build().
*
* @param {Object} options - Instance initialization bag (see `get_instance`)
* @param {string} options.model - Component class name, e.g. 'component_input_text'
* @param {string} options.tipo - Ontology tipo of this component, e.g. 'dd345'
* @param {string} options.section_tipo - Ontology tipo of the parent section, e.g. 'oh1'
* @param {string|number} options.section_id - Record identifier within the section
* @param {string|null} [options.matrix_id] - Time-machine matrix row id (list_tm mode only)
* @param {string} options.mode - Render mode: 'edit', 'list', 'search', etc.
* @param {string} options.lang - Active language tag, e.g. 'lg-nolan'
* @param {string|null} [options.column_id] - Column id when rendering as a grid column
* @param {string} [options.type='component'] - Instance type classifier
* @param {string} options.section_lang - Section-level language tag, e.g. 'lg-eng'
* @param {string} options.parent - Ontology tipo of the structural parent group
* @param {Object|null} [options.context=null] - Server-resolved context (properties, tools, permissions, etc.)
* @param {Object|null} [options.data=null] - Resolved component data for the current record
* @param {Object|null} [options.datum=null] - Full datum shared with parent section
* @param {boolean} [options.is_temporal=false] - True for transient data used in tools
* @param {*} [options.data_source] - Caller-supplied data source hint
* @param {string} [options.view] - View variant, e.g. 'default', 'line'
* @param {Object|null} [options.caller] - Parent instance that owns this component
* @param {boolean} [options.standalone=true] - When true the component fetches its own data;
*   when false it relies on the parent section's shared datum to reduce API calls.
* @param {Object} [options.properties] - Raw ontology properties object
* @returns {Promise<boolean>} Always resolves true on success, false on duplicate-init error
*/
component_common.prototype.init = async function(options) {

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

	// instance key used vars
		self.model			= options.model // structure model like 'component_input_text'
		self.tipo			= options.tipo // structure tipo of current component like 'dd345'
		self.section_tipo	= options.section_tipo // structure tipo like 'oh1'
		self.section_id		= options.section_id // record section_id like 1
		self.matrix_id		= options.matrix_id || null // record matrix_id like 1 (list_tm mode only)
		self.mode			= options.mode // current component mode like 'edit'
		self.lang			= options.lang // current component lang like 'lg-nolan'
		self.column_id		= options.column_id // id of the column when the instance is created to render a column list.
		self.type			= options.type || 'component' // a instance type

		self.section_lang	= options.section_lang // current section lang like 'lg-eng'
		self.parent			= options.parent // tipo of structure parent like a section group 'dd4567'

	// optional vars
		self.context		= options.context	|| null // structure context of current component (include properties, tools, etc.)
		self.data			= options.data		|| null // current specific data of this component
		// data_degraded: true when the API answer did NOT carry this instance's
		// record and the previous data model was kept instead of being emptied
		// (see do_build / save). A degraded instance is still usable; it just
		// has not been re-synced with the server.
		self.data_degraded	= false
		self.datum			= options.datum		|| null // global data including dependent data (used in portals, etc.)
		self.is_temporal	= options.is_temporal ?? false // temporal data (used in tools, etc.)
		// temporal_scope (WC-079): the OWNING TOOL of a temporal instance whose
		// values must survive a reload. Set ONLY by service_tmp_section — a
		// temporal instance without it persists nothing, which is the contract for
		// the propagate tool and the text_area pickers.
		self.temporal_scope	= options.temporal_scope ?? null

	// data_source
		self.data_source = options.data_source

	// DOM
		self.node			= null // node place in light DOM

	// var containers
		self.events_tokens	= [] // array of events of current component
		self.ar_instances	= [] // array of children instances of current instance (used for components, etc.)
		self.services		= [] // array of services instances of current instance (used for autocomplete, etc.)

	// view
		self.view = options.view

	// caller pointer
		self.caller			= options.caller

	// standalone
		// Set the component to manage his data by itself, calling to the database and it doesn't share his data with other through datum
		// if the property is set to false, the component will use datum to get his data and is forced to update datum to share his data with others
		// false option is used to reduce the calls to API server and database, section use to load all data with 1 call and components load his data from datum
		// true options is used to call directly to API and manage his data, used by tools or services that need components standalone.
		self.standalone		= options.standalone ?? true

	// active. Active status (true|false) is set by ui.component.activate/deactivate
		self.active = false

	// properties
		self.properties = options.properties

	// pagination info
		// self.pagination = (self.data && self.data.pagination)
		// 	? self.data.pagination
		// 	: { // pagination info (used in portals, etc.)
		// 		total	: 0,
		// 		offset	: 0,
		// 		limit	: 0
		// 	}

	// set_context_vars. Common context vars re-updated after new build
		// set_context_vars(self, self.context)

	// value_pool. queue of component value changes (needed to avoid parallel change save collisions)
		self.change_value_pool = []

	// changing. True for the whole of a change_value call (save AND the optional
	// refresh). It — not self.status — is what makes overlapping change_value
	// calls queue, because the status is briefly restored around the refresh.
	// @see component_common.change_value
		self.changing = false

	// is_data_changed. bool set as true when component data changes.
		self.is_data_changed = false

	// events subscription
		self.init_events_subscribed = false // initial value (false) is changed on build
		// Two calls:
		// first; set the component_common events, the call is not in the instance and assign the self in the call
		// second; set the specific events of the components, they are part of the instance
		events_subscription(self)
		// set the component events (it could had his own definition or not) in the instance.
		if(typeof self.events_subscription==='function'){
			self.events_subscription()
		}

	// save status. While save action is running, is set to true to prevent save overlapping
		self.saving = false

	// edit-safety primitives (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md). Read by settle()
	// and, through it, by the row window before it releases or retires a row.
		// saving_promise. The pending save's promise; null when no save is pending.
		// @see component_common.prototype.save
		self.saving_promise = null
		// change_value_promise. The running change_value's promise; null otherwise.
		// @see component_common.prototype.change_value
		self.change_value_promise = null
		// commit_seq. Incremented synchronously at the entry of change_value and of
		// set_changed_data — the two doors through which an editor hands a value
		// to its instance. Whoever needs to know whether an editor committed reads
		// it before and after (the row window's synthetic 'change' dispatch).
		self.commit_seq = 0
		// failed_changed_data. What a failed save did not persist (null when
		// nothing failed). Survives a refresh (do_build empties data.changed_data);
		// the next save sends it first. @see register_failed_save
		self.failed_changed_data = null

	// DES
		// component_save (when user change component value) every component is looking if the own the instance was changed.
			/*
			self.events_tokens.push(
				event_manager.subscribe('save_component_'+self.id, (saved_component) => {
					// call component
						console.log("saved_component:",saved_component);
					self.save(saved_component)
					.then( response => { // response is saved_component object

					})
				})
			)
			*/
			//console.log("self.model:",self.model);
			//console.log("self.model:",self.tipo);
			//console.log("self.paginator_id:",self.paginator_id);

		//	self.events_tokens.push(
		//		event_manager.subscribe('paginator_destroy'+self.paginator_id, (active_section_record) => {
		//			// debug
		//			if (typeof self.destroy!=="function") {
		//				console.error("Error. Component without destroy method: ",self);
		//			}
		//			self.destroy()
		//		})
		//	)

		// component_save (when user change component value) every component is looking if the own the instance was changed.
		//event_manager.subscribe('rebuild_nodes_'+self.id, (changed_component) => {
		//	// call component
		//
		//	self.rebuild_nodes(changed_component)
		//	.then( response => { // response is changed_component object
		//
		//	})
		//})

		//event_manager.publish('component_init', self)

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Resolves and locks in the component's context and data, then wires observer
* events for the first time. The entry point for both standalone autoload
* (where the method calls the API itself) and injected-data scenarios (where
* the caller section pre-populates context/data before calling build).
*
* Concurrent build calls are serialised: if a build is already in progress,
* the method returns the pending `_build_waiter` Promise so all callers share
* the same result without duplicate API round-trips. A second call on an
* already-built instance returns true immediately.
*
* After build() resolves, the following are guaranteed:
*   - self.context   is the server-resolved context object for this component
*   - self.data      is the current data item for (tipo, section_tipo, section_id)
*   - self.db_data   is a deep clone of self.data as returned by the server
*   - self.status    === 'built'
*   - event_manager has published 'built_' + self.id
*
* @param {boolean} [autoload=false] - When true the component fetches its own
*   context and data from the API. When false (default), the caller is expected
*   to have injected context and data via options before calling build().
* @returns {Promise<boolean>} Resolves true on success
*/
component_common.prototype.build = async function(autoload=false) {

	const self = this

	// check status
		switch (self.status) {
			case 'building':
				return self._build_waiter;
			case 'built':
				return true;
		}

		self.status = 'building'
		// NO ASYNC PROMISE EXECUTOR (P2-1 / CLI-05).
		//
		// This was `new Promise(async (resolve) => { … })` — biome names it
		// suspicious/noAsyncPromiseExecutor. A throw inside `do_build` became an
		// ORPHAN REJECTION: nothing rejected `_build_waiter`, so it never settled,
		// `status` stayed 'building' FOREVER, and every later build() returned the
		// same dead promise. The component was wedged for the life of the page,
		// with no error surfaced anywhere a curator could see.
		//
		// An async function returns a promise already; the executor bought nothing
		// and cost the rejection path. `finally` is what makes the wedge
		// impossible: the status leaves 'building' whichever way do_build ends.
		self._build_waiter = (async () => {
			try {
				const result = await do_build(self, autoload)
				// status update
				self.status = 'built'
				event_manager.publish('built_' + self.id, self)
				return result
			} catch (error) {
				// A FAILED BUILD IS NOT A BUILT ONE. Marking it 'built' here would
				// trade the wedge for a lie: every later build() would return true
				// without rebuilding, and the component would sit there empty and
				// declared fine. So the status is RESET — a later build() may try
				// again — and the waiter is cleared with it.
				self.build_error = error
				self.status = null
				self._build_waiter = null
				// RELEASE, NOT SUCCESS. render()'s 'building' branch waits on this
				// event; without it a failed build leaves every waiter parked
				// forever (CLI-06/07). They wake, find status null and build_error
				// set, and can act — which is strictly better than never waking.
				event_manager.publish('built_' + self.id, self)
				throw error
			}
		})()

	return self._build_waiter
}//end component_common.prototype.build


/**
* DO_BUILD
* Internal implementation of build() — executed exactly once per lifecycle,
* wrapped inside `_build_waiter` to serialise concurrent callers.
*
* Responsibilities:
*  1. Ensure datum and data have safe default shapes.
*  2. Resolve request_config_object (main-type Dédalo API config entry).
*  3. If autoload is true: fetch context + data from the API, then update datum
*     (shared path for non-standalone, private copy for standalone).
*  4. Call set_context_vars() to push context-derived properties onto the instance.
*  5. Call init_events_subscription() to wire ontology-driven observer events.
*  6. Take a deep-clone snapshot into db_data (baseline for change detection).
*
* @param {Object} self - The component instance being built
* @param {boolean} autoload - Whether to fetch data from the API
* @returns {Promise<boolean>} true on success, false when the API returns no valid context
*/
/**
* IS_UNRESOLVED_ID
* The THREE spellings of "this remove names no item": null, undefined, and the empty
* string. Module scope on purpose — `save()` (the wire door) and `change_value` (the
* pre-flight) must refuse exactly the same set as the server predicate
* `unnamedRemoveRefusal` (src/core/section/record/save_component.ts), and three
* separate inline copies is how they drift apart. Before 2026-08-30 the wire door
* listed only two of the three, so an `id:''` remove passed every client door and died
* at the wire as a generic failed save.
*
* `0` and `'0'` are REAL, deletable ids: this is a value test, never a falsiness test.
* @param {*} id
* @returns {bool}
*/
const is_unresolved_id = (id) => id===null || typeof id==='undefined' || id===''

// A remove on a model whose entries carry NO item id (`removes_by_locator`:
// component_relation_children, whose entries are COMPUTED by the server) names
// its target by the RECORD LOCATOR in `value` instead. That is a named remove,
// not DATA-06's wildcard — the server removes exactly that child
// (src/core/relations/children_write.ts). Every other model keeps the id law.
const names_record_locator = (self, el) => self?.removes_by_locator===true
	&& el?.value!==null && typeof el?.value==='object'
	&& typeof el.value.section_tipo==='string' && el.value.section_tipo!==''
	&& !is_unresolved_id(el.value.section_id)

const do_build = async (self, autoload) => {

	// self.datum. On building, if datum is not created, creation is needed
		// if (!self.datum) self.datum = {data:[]}
		self.datum = self.datum || {
			data	: [],
			context	: []
		}
		self.data = self.data || {
			entries : null
		}
		// changed_data. Set as empty array always
		self.data.changed_data = []

	// request_config_object
		if (!self.context) {
			// request_config_object. get the request_config_object from request_config
			self.request_config_object = self.request_config
				? self.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
				: {}
		}else{
			// request_config_object. get the request_config_object from context
			self.request_config_object = self.context && self.context.request_config
				? self.context.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
				: {}
		}

	// load data on auto-load true
	// when the auto-load if false the data will be injected by the caller (as section_record or others)
		if (autoload===true) {

			// rqo. Request Query Object
				const rqo = {
					source	: create_source(self, 'get_data'),
					action	: 'read'
				}

			// data_manager get context and data from the database
				const api_response = await data_manager.request({
					body : rqo
				})

				// server: wrong response
				if (!api_response) {
					return false
				}
				// server: a failure envelope rejects with its own ApiError (its code tells
				// a gone tipo from a transport/server failure), not a TypeError on datum
				if (api_response.ok===false) {
					throw api_response.error || new Error('component build: failure envelope without error')
				}
				// server: bad build component context
				const datum = response_data(api_response)
				if(!datum.context?.length){
					console.error("Error!!!!, component without context:", api_response, rqo);
					return false
				}

				if(SHOW_DEVELOPER===true) {
				// console.log(`COMPONENT ${self.model} api_response:`,self.id, api_response);
					dd_console(`[component_common.build] COMPONENT: ${self.model} api_response:`, 'DEBUG', api_response)
				}

			// Context
				if(!self.context){
					const context = datum.context.find(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo)
					if (!context) {
						console.error("context not found in api_response:", api_response);
					}else{
						self.context = context
					}
				}

			// data
			// NOTE a miss is NOT a valid answer. Adopting `{}` would drop the
			// instance identity (tipo, section_tipo, section_id) and `entries`
			// AND the `changed_data` array installed above, leaving a component
			// that looks alive, whose get_value() is undefined and whose saves
			// carry a garbage shape. Keep the placeholder, stamp the identity so
			// downstream lookups still match, and mark the instance degraded.
				const data = datum.data.find(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo && String(el.section_id)===String(self.section_id))
				if(!data){
					console.error(`Error: data not found in api_response for ${self.tipo} (${self.section_tipo}/${self.section_id}):`, api_response);
					// keep whatever model the instance already has (the
					// {entries:null} placeholder installed above, or the data
					// passed in options) EXACTLY as it is: it may be the very
					// object shared through self.datum, so nothing is stamped
					// onto it here — a corrected identity would be written into
					// shared state, and a stale one would survive the stamp
					// anyway. The instance is marked degraded instead.
					self.data_degraded		= true
				}else{
					self.data			= data
					self.data_degraded	= false
				}

			// Update datum when the component is not standalone, it's dependent of section or others with common datum
				if(!self.standalone){
					// update shared datum
					await self.update_datum(datum)
				}else{
					// set 'private' datum
					self.datum.context	= datum.context
					self.datum.data		= datum.data
				}

			// rqo. build again rqo with updated request_config if exists
				// if (self.context.request_config) {
				// 	self.rqo.show = self.build_rqo('show', self.context.request_config, 'get_data')
				// }
		}

	// update instance properties from context:
	// 	type, label, tools, value_separator, permissions
	// Note that 'show_interface' is assigned here with criteria: self.context.properties.show_interface || self.request_config_object.show_interface
		set_context_vars(self, self.context)

	// subscribe to the observer events (important: only once)
		init_events_subscription(self)

	// set the server data to preserve the data that is already saved in DDBB
		self.db_data = clone(self.data)

	// status update
		self.status = 'built'

	// dd_console(`__Time to build component: ${(performance.now()-t0).toFixed(3)} ms`,'DEBUG', [self.tipo,self.model])


	return true
}//end do_build



/**
* INIT_EVENTS_SUBSCRIPTION
* Wires the ontology-driven observer subscriptions declared in
* context.properties.observe for the component instance `self`.
*
* The observe array lives in the ontology (not in code) and controls
* inter-component reactivity: one component can watch another's value changes
* and react (e.g. auto-refresh) without the observable needing to know its
* observers. A typical use is a calculated-field component listening to a
* radio-button's 'update_value' event to trigger a refresh.
*
* Each observe entry shape:
*   {
*     component_tipo : string    — the observable component tipo to listen to
*     client : {
*       event   : string         — event name published by the observable, e.g. 'update_value'
*       perform : { function: string } — method name to call on self, e.g. 'refresh'
*     }
*     server : { filter: bool }  — server-side config only; ignored client-side
*   }
*
* Called inside do_build() after set_context_vars(). The guard
* `self.init_events_subscribed` prevents double-subscription when build() is
* called more than once (which can happen via refresh()).
*
* Subscription scoping: events are keyed on the combination
* `event +'_'+ section_tipo +'_'+ section_id +'_'+ component_tipo` so that
* observers only react to their own section record's observable — not to
* homologous components in other open records.
*
* @param {Object} self - The component instance to attach subscriptions to
* @returns {boolean} true when subscriptions were attached; false when skipped
*   (non-edit mode or already subscribed)
*/
export const init_events_subscription = function(self) {

	// check mode
		if (self.mode!=='edit') {
			// only in edit mode are attached the events
			return false
		}

	// check already subscribed
		if(self.init_events_subscribed===true) {
			// console.log("-->> [component_common.init_events_subscription] already subscribed events:", self);
			return false
		}

	// events subscription (from component properties)
	// the ontology can define a observer property that specify the tipo that this component will listen
	// the event has a scope of the same section_tipo and same section_id for the observer and observable
		const observe = (self.context.properties && typeof self.context.properties.observe!=='undefined')
			? (self.context.properties.observe || null)
			: null
		if(observe) {

			const observe_length = observe.length
			for (let i = observe_length - 1; i >= 0; i--) {

				// Ignore non client events (server events for example)
				if(!observe[i].client){
					continue;
				}

				const component_tipo	= observe[i].component_tipo // string target event component tipo
				const event_name		= observe[i].client.event || null // string event name as 'update_data'
				const perform			= observe[i].client.perform || null // string action to exec like 'update_data'
				const perform_function 	= perform
					? perform.function
					: null
				if(perform && perform_function && typeof self[perform_function]==='function') {

					// the event will listen the id_base ( section_tipo +'_'+ section_id +'_'+ component_tipo)
					// the id_base is built when the component is instantiated
					// this event can be fired by:
					// 		event_manager.publish(event +'_'+ self.section_tipo +'_'+ self.section_id +'_'+ self.tipo, data_to_send)
					// or the sort format with the id_base of the observable component:
					// 		event_manager.publish(event +'_'+ self.id_base, data_to_send)
					const id_base = self.section_tipo +'_'+ self.section_id +'_'+ component_tipo

					// debug
						if(SHOW_DEBUG===true) {
							// console.log('SUBSCRIBE [init_events_subscription] event:', event_name +'_'+ id_base);
							// console.log("SUBSCRIBE info ",
							// 	'self.id:', self.id,
							// 	'id_base:', id_base,
							// 	'perform:', perform
							// );
						}

					self.events_tokens.push(
						event_manager.subscribe(event_name +'_'+ id_base, self[perform_function].bind(self))
					)

				}else{

					// event_name is defined but not perform case
					if (event_name) {
						console.group(`Invalid observe ${self.tipo} - ${self.model}`);
						console.warn(`Invalid observe perform. Target function '${perform_function}' does not exists in ${self.model}:`, observe[i], typeof self[perform_function]);
						console.warn(`self.context.properties.observe of ${self.model} - ${self.tipo} :`, observe);
						console.groupEnd();
					}
				}
			}
		}

	// set as subscribed
		self.init_events_subscribed = true


	return true
}//end init_events_subscription



/**
* SAVE
* Persists `changed_data` to the server via the Dédalo API, manages UI
* feedback classes (saving / loading / error / save_success / modified), and
* keeps the local data model in sync with the server response.
*
* Flow:
*  0. Entry guard: while the page identity is revoked (a re-login authenticated
*     another user and the reload is pending or was cancelled) nothing is sent —
*     the edit stays 'modified' / unsaved and save() answers false.
*  1. Guard: skip if a save is already in progress (self.saving === true).
*  2. Validate changed_data — must be a non-empty array.
*  3. Optimisation: for action='update' items, compare each value against the
*     db_data snapshot with is_equal(). If nothing actually changed, abort.
*  4. Clear 'modified' + set 'saving'/'loading', then clone self.data, inject
*     changed_data, build an RQO and POST via data_manager.
*  5. On success: update self.data + self.db_data from the server response, run
*     the success animation, and retire this instance's unsaved registration
*     plus the coarse before-unload assertion (window.unsaved_data is DERIVED
*     from the events.js registry; other dirty components keep it armed).
*     On error: restore 'modified' (data is still unsaved) and set 'error'.
*  6. On auth failure ('auth.not_logged'): handle_api_error opens the re-login
*     overlay; the save is retried ONCE when it reports recovered:true, which it
*     does only when the page's OWN user logged back in (error_dispatch
*     relogin_identity==='same'). Another identity reloads the page instead.
*  7. Always publish 'save' (general) and 'save_' + self.id_base (component-specific)
*     events with { instance, api_response } payload.
*
* saving_promise (edit-safety, engineering/wire_contract/WC-2026-10-30-section-record-row-box.md): assigned right
* after the guard (step 1) and nulled when this call resolves — so its presence
* means a save is pending. The two pre-guard exits (step 0 and the step-1
* guard) leave an existing saving_promise untouched; every later exit resolves
* it; the recovered retry (step 6) keeps the OUTER promise as saving_promise
* and resolves it with the retry's answer. A failed save (identity refusal or
* error branch) registers the instance as unsaved with the failed changed_data
* (self.failed_changed_data). Every later save of the instance sends that
* failed changed_data FIRST, then the requested one (with_failed_changed_data),
* so a later successful edit can never retire an earlier failed one unsent.
*
* ChangedDataItem shape:
*   {
*     action : string  — 'update' | 'set_data' | 'remove' | 'clear'
*     key    : number|null — array index within data.entries (null = append)
*     id     : *|null     — stable item id; REQUIRED by 'remove'
*     value  : *          — the new value to persist
*   }
*
* (!) A 'remove' MUST name the item it deletes. One without an id is refused
* below and never reaches the wire (DATA-06 — see update_data_value's docblock
* for the wildcard it used to trigger). A deliberate wipe is action:'clear'.
*
* (!) component_password is excluded from the db_data snapshot update after save
* to avoid storing the hash in the client-side baseline.
*
* @param {Array} [new_changed_data] - ChangedDataItem array. Falls back to
*   self.data.changed_data when omitted.
* @returns {Promise<Object|boolean>} The raw api_response object on completion;
*   false when the save was skipped (concurrent, invalid data, or no-change).
*   Always a Promise (also on the two synchronous pre-guard exits).
*/
component_common.prototype.save = function(new_changed_data) {

	const self = this

	// page identity guard (LEAD-2 + CLIENT-5) — THE WRITE DOOR. A re-login on
	// this page authenticated another (or an unresolvable) identity: the page's
	// state still belongs to the previous user and a reload is pending (or was
	// cancelled). Sending now would write this user's edit under that session.
	// Nothing goes to the wire; the edit keeps its 'modified' / unsaved marks so
	// the before-unload guard still knows about it.
	// (!) PRE-GUARD EXIT: it never touches self.saving_promise — a save already
	// on the wire keeps its own promise (settle() must still wait for it).
	if (is_page_identity_revoked()) {
		const msg = 'Ignored save. The page identity changed on re-login; reload the page.'
		console.warn(`[component_common] ${self.model} ${self.tipo}: ${msg}`)
		// FAILURE REGISTERS: the refused edit is unsaved data. Register the
		// instance with the refused changed_data, so the unsaved-data guard, the
		// row window's pinning and save_unsaved_components all still see it
		// (the change_value path never filled changed_data on its own).
		register_failed_save(self, new_changed_data || self.data?.changed_data)
		// observers must not be left waiting on a save that will never land
		// (the same notification the other refusals below publish)
		event_manager.publish('save', {
			instance		: self,
			api_response	: null,
			msg				: msg
		})
		return Promise.resolve(false)
	}

	// set save status to prevent save orders overlapping
	// (!) PRE-GUARD EXIT: never replace the in-flight save's promise with a
	// resolved one — a settle() awaiting saving_promise would then think the
	// real save (still on the wire) had finished.
	if (self.saving) {
		console.warn(`${self.model} is already saving data. Stop saving to prevent double action.`);
		return Promise.resolve(false)
	}
	self.saving = true

	// saving_promise. Assigned ONLY here, after the guard passed: its presence
	// means "a save is pending". Every exit of run_save resolves it and the
	// finally nulls it — identity-checked, so a recovered retry that re-entered
	// save() (run_save chains the outer promise to the nested call) never clears
	// a promise that is not its own.
		const own = {promise: null}
		const tracked = (async () => {
			try {
				return await run_save(self, new_changed_data, own)
			} finally {
				if (self.saving_promise===own.promise) {
					self.saving_promise = null
				}
			}
		})()
		own.promise			= tracked
		self.saving_promise	= tracked

	return tracked
}//end save



/**
* RUN_SAVE
* The body of component_common.prototype.save once the concurrency guard has
* passed (self.saving is already true). Split out so save() can own the
* saving_promise lifecycle: every return below resolves that promise.
*
* @param {Object} self - The component instance
* @param {Array} [new_changed_data] - ChangedDataItem array (see save)
* @param {Object} own - {promise} the saving_promise this call owns; read by the
*   recovered retry to chain the outer promise to the nested save()
* @returns {Promise<Object|boolean>} See save()
*/
const run_save = async function(self, new_changed_data, own) {

	// released_orphan. True when this save sweeps an orphaned unsaved instance
	// (success branch below); the orphan is destroyed once the save is done.
		let released_orphan = false

	// fallback to self.data.changed_data if not received.
	// (!) A previously FAILED edit (self.failed_changed_data) is sent FIRST, in
	// the same request: a later successful save must never retire the
	// registration of an edit that is still not persisted.
		let changed_data = with_failed_changed_data(self, new_changed_data || self.data.changed_data)

	// check changed_data format
		if (!changed_data || !Array.isArray(changed_data) || changed_data.length < 1) {
			if(SHOW_DEBUG===true) {
				console.warn("Invalid changed_data [stop save]:", changed_data)
				console.trace()
			}
			const msg = "Ignored save. changed_data is undefined or empty!"

			// dispatch event save (with error msg to notify observers)
				event_manager.publish('save', {
					instance		: self,
					api_response	: null,
					msg				: msg
				})

			// update save status
			self.saving = false

			return false
		}

	// remove target guard (DATA-06, 2026-08-30) — THE WIRE DOOR.
	// update_data_value already refuses an unnamed remove, but save() is reachable
	// without it: save_unsaved_components() and every caller that fills
	// self.data.changed_data by hand flush straight through here. A remove whose id
	// is null/undefined used to mean "clear every entry in every language" on the
	// server, which then answered success — so one unresolved row id destroyed the
	// component with no visible symptom. Refuse it here too: this is the last point
	// where the item is still ours. A deliberate wipe uses action:'clear'.
		// THREE SPELLINGS OF "NO ID", and this door must know all three or it is
		// narrower than the law the comments above it state. The server predicate
		// `unnamedRemoveRefusal` (save_component.ts) refuses null, undefined AND the
		// empty string; `update_data_value` normalises all three. Before 2026-08-30
		// this guard listed only two, so an `id:''` remove passed every client door
		// and died at the wire as a generic failed save — the refusal arriving where
		// the user could do nothing with it instead of where they made the gesture.
		// `0` and `'0'` are REAL, deletable ids and must never be caught here.
		const unresolved_remove = changed_data.find(el =>
			el && el.action==='remove' && is_unresolved_id(el.id) && !names_record_locator(self, el)
		)
		if (unresolved_remove) {

			const msg = 'Ignored save. A remove without an item id was refused (use action "clear" for a deliberate wipe).'
			console.error('[component_common] save: ' + msg, {
				model			: self.model,
				tipo			: self.tipo,
				section_tipo	: self.section_tipo,
				section_id		: self.section_id,
				changed_data	: changed_data
			})

			// dispatch event save (with error msg to notify observers), exactly as
			// the invalid-changed_data refusal above does — observers must not be
			// left waiting on a save that will never land.
				event_manager.publish('save', {
					instance		: self,
					api_response	: null,
					msg				: msg
				})

			// update save status
			self.saving = false

			return false
		}

	// Optimization: check if data has actually changed (only for action='update' items)
	// (!) NEVER on a degraded instance: db_data is then the last baseline the
	// server actually confirmed, and the local model has moved past it, so
	// "unchanged" here would mean "silently refuse to retry the save that the
	// server never acknowledged". A degraded instance always goes to the wire.
		// (!) ONLY when EVERY item is an 'update': a batch that also carries an
		// insert/remove/clear (e.g. a retried failed insert sent first, see
		// with_failed_changed_data) is never cancelled because its update items
		// happen to equal the baseline.
		const update_items = self.data_degraded===true
			? []
			: changed_data.filter(el => el.action === 'update')
		if (update_items.length > 0 && update_items.length===changed_data.length) {

			const all_items_unchanged = update_items.every(item => {
				const original_value = item.id !== null && item.id !== undefined
					? self.db_data.entries?.find(entry => entry?.id === item.id)
					: self.db_data.entries?.[item.key];
				return is_equal(item.value, original_value);
			});

			if (all_items_unchanged) {
				if(SHOW_DEBUG===true) {
					console.warn(get_label.data_was_not_modified_save_canceled || 'The data has not been modified. Saving canceled');
				}
				// reset page unload warning: retire OWN unsaved registration only —
				// window.unsaved_data is DERIVED (events.js registry) and stays
				// armed while OTHER components are still dirty. The coarse
				// instance-less assertion (filter_records/security_access
				// keystroke guards, which save through this same prototype) is
				// cleared too, as a completed save round always did.
				self.failed_changed_data = null
				deregister_unsaved_instance(self)
				set_before_unload(false)

				self.saving = false
				return false
			}
		}

	// supersession (edit-safety, see resolve_supersession). Decided here, right
	// before the request, PER ITEM and BY HAND-OVER ORDER (edit stamps): an
	// outgoing item a NEWER pending edit of the same field target covers is not
	// sent; an OLDER pending failed edit (or orphan item) this save covers is
	// retired. Items on other targets of the field are never touched.
		changed_data = resolve_supersession(self, changed_data)
		if (changed_data.length < 1) {
			// everything this save would have sent is superseded by a newer
			// pending edit of the same target: nothing goes to the wire
			const msg = 'Ignored save. A newer edit of the same field supersedes this edit.'
			console.warn(`[component_common] ${self.model} ${self.tipo}: ${msg}`)
			if (!has_pending_edit(self)) {
				if (orphaned_unsaved.has(self)) {
					retire_orphan(self)
				} else {
					deregister_unsaved_instance(self)
				}
			}
			event_manager.publish('save', {
				instance		: self,
				api_response	: null,
				msg				: msg
			})
			self.saving = false
			return false
		}

	// UI: remove previous status classes and add 'saving'
	// (!) 'modified' (the orange top bar) is dropped HERE, not after the response.
	// Once the request is in flight the component is 'saving', no longer 'unsaved';
	// keeping it until the response painted the orange bar for the whole round-trip
	// and the user saw orange-then-green instead of the green line alone.
	// The error branch below re-adds it, so a failed save still flags unsaved data.
		if (self.node) {
			self.node.classList.remove('error', 'save_success', 'modified')
			self.node.classList.add('saving')
		}

	// Internal helper: send_data
		const send_data = async () => {
			try {
				// data. isolated cloned var and set received changed_data
					const data = clone(self.data)
					data.changed_data = changed_data

				// source
					const source = create_source(self, null)

				// rqo
					const rqo = {
						action	: 'save',
						source	: source,
						data	: data
					}

				// data_manager API request
					const api_response = await data_manager.request({
						use_worker	: false,
						body		: rqo
					})

					// debug
					if(SHOW_DEBUG===true) {
						dd_console(`[component_common.save] api_response ${self.model} ${self.tipo}`, 'DEBUG', api_response)
						if (request_failed(api_response)) {
							console.error('[component_common.save] api_response ERROR:', api_response);
						}
					}

				return api_response

			} catch(error) {
				console.error("+++++++ COMPONENT SAVE ERROR:", error);
				// A rejection here never reached the server (the transport resolves
				// its own failures into an envelope). Return the SAME failure
				// envelope shape the transport does, with a typed ApiError.
				return {
					ok		: false,
					result	: false, // COMPAT v1 (REMOVAL: census 0)
					error	: normalize_transport_error(error)
				}
			}
		}

		// lock component events setting 'loading' class (for UI feedback)
			if (self.node) {
				self.node.classList.add('loading')
			}

		// Execute API call
		const api_response = await send_data()


	// Process Result
	// (!) ONE accessor per flow: this flow — save() here, change_value() below —
	// reads the payload through response_data() everywhere, so the instance and
	// the datum always hold the SAME object graph and the next save cannot ship
	// stale entries.
		const result = response_data(api_response)

		if (request_failed(api_response)) {

			// ERROR CASE
			// restore 'modified': the data is still unsaved, so the orange marker
			// must come back (it was cleared when the request started)
			if (self.node) {
				self.node.classList.remove('saving', 'loading')
				self.node.classList.add('error', 'modified')
			}

			console.error('component save error:', api_response.error)

			// FAILURE REGISTERS. The edit did not reach the database: register the
			// instance as unsaved and keep the failed changed_data on it. Before
			// this, the change_value path (which never fills changed_data) re-added
			// the orange 'modified' marker and nothing else — the unsaved-data
			// guard, save_unsaved_components (changed_data.length>0) and the row
			// window's pinning were all blind to the failed edit. Registered BEFORE
			// the handler runs: a recovered retry that succeeds retires it again.
			register_failed_save(self, changed_data)

			// THE handler. `recovered:true` means the cause is gone (the user
			// re-logged in), so the save is worth repeating; anything else was
			// already shown to the user by the policy.
			const {recovered} = await handle_api_error(api_response.error, {wrapper: self.node})
			if (recovered===true) {
				// restore styles
				self.node?.classList.remove('error')
				// release the concurrency guard BEFORE repeating the call, or the
				// retry hits the "already saving" short-circuit at the top. The
				// repeated save publishes its own 'save' event.
				self.saving = false
				// CHAIN, never replace: the nested save() assigns its own
				// saving_promise synchronously; put the OUTER one back, so a
				// settle() waiting on this save waits for the retry too (this
				// function returns the nested promise, so the outer resolves with
				// its answer and only then clears saving_promise).
				const retry = self.save(changed_data)
				if (own && own.promise && self.saving_promise===retry) {
					self.saving_promise = own.promise
				}
				return retry
			}

		} else {

			// SUCCESS CASE
			if (self.node) {
				self.node.classList.remove('saving', 'loading')
			}

			// Update Data Model
			// NOTE the save SUCCEEDED; a record missing from the response is a
			// server-side anomaly, never an instruction to empty the model.
			// Overwriting self.data with `{}` here loses tipo/section_tipo/
			// section_id/entries and, one line below, empties the db_data
			// change-detection baseline — so every later edit reads as changed
			// and get_value() returns undefined while the component still looks
			// alive. Keep the model that was just saved, log unconditionally
			// (the old warning was invisible outside SHOW_DEBUG) and mark the
			// instance degraded so a refresh can re-sync it.
				const result_data = Array.isArray(result?.data) ? result.data : []
				const data = result_data.find(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo && String(el.section_id)===String(self.section_id))
				if(!data){
					console.error(`Error: data not found for ${self.tipo} in API save result. Keeping the previous data model.`, result);
					self.data_degraded = true
				}else{
					self.data			= data
					self.data_degraded	= false
				}

			// Update DB Data snapshot (for future change detection)
			// (!) NOT when the answer omitted this record: advancing the
			// baseline to a value the server never confirmed would assert the
			// edit is stored, and the no-change short-circuit above would then
			// refuse every later attempt to save it. Leaving db_data on the last
			// CONFIRMED value keeps change detection pessimistic, so the next
			// save is really sent.
				if (self.model !== 'component_password' && self.data_degraded!==true) {
					self.db_data = clone(self.data)
				}

			// UI: Success Animation
				if (self.mode === 'edit') {
					ui.component.exec_save_successfully_animation(self)
				}

			// retire ONLY what this save carried (the earlier failed edit
			// included: with_failed_changed_data sent it first). A failed item
			// registered WHILE this save was on the wire (the identity-revoked
			// exit runs before the concurrency guard) was never sent: it stays
			// failed, is mirrored back into the replaced data.changed_data, and
			// keeps the instance registered.
				const still_failed = Array.isArray(self.failed_changed_data)
					? self.failed_changed_data.filter(item => !changed_data.includes(item))
					: []
				self.failed_changed_data = still_failed.length > 0 ? still_failed : null
				if (still_failed.length > 0 && self.data) {
					const current = Array.isArray(self.data.changed_data) ? self.data.changed_data : []
					self.data.changed_data = [...still_failed, ...current.filter(item => !still_failed.includes(item))]
				}

			// orphan sweep. An orphaned unsaved instance (its row was torn down
			// while it was dirty, see orphan_unsaved_instance) is released by its
			// first successful save: out of orphaned_unsaved BEFORE the
			// deregistration below recomputes the flag, destroyed after this save
			// completes (end of this function). Never while a never-sent failed
			// item remains (above): destroying it would drop that edit.
				if (self.failed_changed_data===null && orphaned_unsaved_writers.delete(self)===true) {
					released_orphan = true
				}

			// Reset page unload warning: retire OWN unsaved registration only —
			// window.unsaved_data is DERIVED (events.js registry) and stays
			// armed while OTHER components are still dirty. The coarse
			// instance-less assertion (filter_records/security_access keystroke
			// guards, which save through this same prototype) is cleared too,
			// as a completed save always did. NOT while a never-sent failed
			// item remains (above): its registration is the only thing the
			// unsaved guard, settle() and the sweep can still see it by.
				if (self.failed_changed_data===null) {
					deregister_unsaved_instance(self)
					set_before_unload(false)
				}

			// (!) no 'modified' removal here: it was already cleared when the
			// request started, so the success animation runs on a clean wrapper

		}//end else

		// Dispatch Events
			// General save event
			event_manager.publish('save', {
				instance		: self,
				api_response	: api_response
			})

			// Specific component save event
			event_manager.publish('save_' + self.id_base, {
				instance		: self,
				api_response	: api_response
			})

		// Reset internal saving flag
		self.saving = false

	// released orphan: nothing references it any more (no caller ar_instances,
	// no instance cache) — destroy it once this save and any change_value around
	// it have finished reading self.data. Not awaited: the caller gets its answer
	// now.
		if (released_orphan===true) {
			destroy_released_orphan(self)
		}

	return api_response
}//end run_save



/**
* REGISTER_FAILED_SAVE
* A save that did not reach the database leaves its edit UNSAVED: keep the
* changed_data on the instance — MERGED into self.failed_changed_data (an
* earlier failed edit is never replaced by a later one) and mirrored to
* data.changed_data (so save_unsaved_components' changed_data filter and
* settle() see it) — and register the instance in the events.js unsaved
* registry (so the unsaved-data guard and the row window's pin 4 see it). An
* empty/invalid changed_data registers nothing — there is no edit to keep, and
* a registration without one could never be retried or retired.
*
* (!) component_password is registered but its changed_data is NOT kept: a
* password is committed only by its own Save (save_password), never by the
* auto-save sweep, and a clear-text value must not linger in changed_data for
* the sweep to resend (see check_unsaved_data and test_component_password).
*
* @param {Object} self - The component instance whose save failed
* @param {Array} changed_data - The ChangedDataItem array that was not saved
* @returns {boolean} true when the instance was registered
*/
const register_failed_save = function(self, changed_data) {

	if (!self.data || !Array.isArray(changed_data) || changed_data.length < 1) {
		return false
	}

	if (self.model!=='component_password') {
		// stamped here at the latest (a refused edit never reached run_save)
		stamp_edit_items(changed_data)
		// (!) OWN arrays, never shared: data.changed_data is mutated in place by
		// set_changed_data, and an alias would let a later edit (or its revert)
		// rewrite the failed set. The mirror keeps any item handed over while
		// the save was in flight (after the failed ones).
		const failed = [...with_failed_changed_data(self, changed_data)]
		self.failed_changed_data = failed
		const current = Array.isArray(self.data.changed_data) ? self.data.changed_data : []
		self.data.changed_data = [...failed, ...current.filter(item => !failed.includes(item))]
	}
	register_unsaved_instance(self)

	return true
}//end register_failed_save



/**
* WITH_FAILED_CHANGED_DATA
* The changed_data a save must send: the instance's pending FAILED items
* (self.failed_changed_data) first, in their order, then the requested ones.
* Items are matched BY IDENTITY (register_failed_save stores the very items it
* was given, and every retry passes them back), so a retry of the failed set
* itself is not doubled. Never mutates either array.
*
* @param {Object} self - The component instance
* @param {Array|undefined} requested - The changed_data the caller asked to save
* @returns {Array|undefined} requested itself when nothing failed before;
*   otherwise a new array (failed items not in requested, then requested)
*/
const with_failed_changed_data = function(self, requested) {

	const failed = self.failed_changed_data
	if (!Array.isArray(failed) || failed.length < 1 || failed===requested) {
		return requested
	}
	const asked = Array.isArray(requested) ? requested : []
	const missing = failed.filter(item => !asked.includes(item))

	return missing.length > 0
		? [...missing, ...asked]
		: requested
}//end with_failed_changed_data



/**
* FIELD_KEY
* The identity of the stored field an instance edits: id_base
* (section_tipo + section_id + component_tipo) plus lang — the same identity
* the sync_data_ channel uses (events_subscription.js). null when unknown.
*
* @param {Object} instance
* @returns {string|null}
*/
const field_key = function(instance) {

	return (instance && instance.id_base)
		? instance.id_base + '_' + instance.lang
		: null
}//end field_key



/**
* HAS_PENDING_EDIT
* True when the instance still holds something to send: data.changed_data or
* failed_changed_data non-empty.
*
* @param {Object} instance
* @returns {boolean}
*/
const has_pending_edit = function(instance) {

	return (Array.isArray(instance?.data?.changed_data) && instance.data.changed_data.length > 0) ||
		(Array.isArray(instance?.failed_changed_data) && instance.failed_changed_data.length > 0)
}//end has_pending_edit



// edit_seq / edit_stamps. The HAND-OVER ORDER of changed_data items, page-wide:
// an item is stamped the first time the edit-safety code sees it —
// set_changed_data (the hand-over itself), the save that sends it, an orphaning,
// or a supersession scan. A retry keeps its original stamp, so a resent failed
// edit is never mistaken for a fresh one (WeakMap: frozen items are fine, and
// an item that is gone is forgotten).
	let edit_seq = 0
	const edit_stamps = new WeakMap()

/**
* STAMP_EDIT_ITEMS
* Give every not-yet-stamped item of `items` the next hand-over stamp, in order.
*
* @param {Array|undefined} items - ChangedDataItem array
* @returns {void}
*/
const stamp_edit_items = function(items) {

	if (!Array.isArray(items)) {
		return
	}
	for (const item of items) {
		if (item && typeof item==='object' && !edit_stamps.has(item)) {
			edit_seq++
			edit_stamps.set(item, edit_seq)
		}
	}
}//end stamp_edit_items



/**
* EDIT_STAMP
* The hand-over stamp of a changed_data item (stamping it now when unseen).
*
* @param {Object} item
* @returns {number} 0 for a non-object
*/
const edit_stamp = function(item) {

	stamp_edit_items([item])

	return edit_stamps.get(item) ?? 0
}//end edit_stamp



// ITEM_SCOPED_ACTIONS. changed_data actions the server applies to ONE item
// (save_component.ts: update/remove by id, insert by locator/append,
// add_new_element links a new record). Every other action (set_data, clear,
// sort_data, sort_by_column, anything unknown) acts on the WHOLE field.
	const ITEM_SCOPED_ACTIONS = new Set(['update', 'insert', 'remove', 'add_new_element'])

/**
* EDIT_TARGETS
* What a changed_data item writes, as comparable target keys:
*  - null — the whole field (set_data, clear, sort_*, unknown actions);
*  - ['id:<id>'] — an item named by its id;
*  - ['key:<key>'] — an 'update' without id (key = entries index);
*  - ['loc:<section_tipo>|<section_id>'] — an insert/remove of a locator;
*  - [] — an independent append (an insert of a literal, add_new_element):
*    it overlaps nothing but a whole-field edit.
*
* @param {Object} item - ChangedDataItem
* @returns {Array<string>|null}
*/
const edit_targets = function(item) {

	if (!item || typeof item!=='object' || !ITEM_SCOPED_ACTIONS.has(item.action)) {
		return null
	}

	const targets = []
	if (!is_unresolved_id(item.id)) {
		targets.push('id:' + String(item.id))
	} else if (item.action==='update' && Number.isInteger(item.key)) {
		targets.push('key:' + item.key)
	}
	const value = item.value
	if ((item.action==='insert' || item.action==='remove') &&
		value && typeof value==='object' && value.section_tipo && value.section_id!==undefined && value.section_id!==null) {
		targets.push('loc:' + value.section_tipo + '|' + String(value.section_id))
	}

	return targets
}//end edit_targets



/**
* EDITS_OVERLAP
* True when two changed_data items of the same field write the same thing: a
* whole-field edit overlaps everything; item edits overlap when a target is
* shared. Two edits that do NOT overlap are independent on the server (a retry
* of one never writes over the other).
*
* @param {Object} a
* @param {Object} b
* @returns {boolean}
*/
const edits_overlap = function(a, b) {

	const targets_a = edit_targets(a)
	const targets_b = edit_targets(b)
	if (targets_a===null || targets_b===null) {
		return true
	}

	return targets_a.some(target => targets_b.includes(target))
}//end edits_overlap



/**
* SAME_EDIT_TARGET
* True when two ITEM-scoped changed_data items name the same item (a shared
* target key). Unlike edits_overlap, a whole-field edit is never "the same
* target" of an item edit: reverting one item does not make a set_data moot.
*
* @param {Object} a
* @param {Object} b
* @returns {boolean}
*/
const same_edit_target = function(a, b) {

	const targets_a = edit_targets(a)
	const targets_b = edit_targets(b)

	return Array.isArray(targets_a) && Array.isArray(targets_b) &&
		targets_a.some(target => targets_b.includes(target))
}//end same_edit_target



/**
* PENDING_ITEMS
* Every changed_data item an instance still holds to send (failed ones first),
* each once.
*
* @param {Object} instance
* @returns {Array<Object>}
*/
const pending_items = function(instance) {

	const failed	= Array.isArray(instance?.failed_changed_data) ? instance.failed_changed_data : []
	const requested	= Array.isArray(instance?.data?.changed_data) ? instance.data.changed_data : []

	return [...new Set([...failed, ...requested])]
}//end pending_items



/**
* DROP_PENDING_ITEMS
* Remove `items` (by identity) from an instance's failed_changed_data and
* data.changed_data. Never mutates the arrays in place (another holder may
* share them); failed_changed_data becomes null when emptied.
*
* @param {Object} instance
* @param {Array<Object>} items
* @returns {void}
*/
const drop_pending_items = function(instance, items) {

	if (!instance || !Array.isArray(items) || items.length < 1) {
		return
	}
	if (Array.isArray(instance.failed_changed_data)) {
		const kept = instance.failed_changed_data.filter(item => !items.includes(item))
		instance.failed_changed_data = kept.length > 0 ? kept : null
	}
	if (instance.data && Array.isArray(instance.data.changed_data)) {
		instance.data.changed_data = instance.data.changed_data.filter(item => !items.includes(item))
	}
}//end drop_pending_items



/**
* RESOLVE_SUPERSESSION
* Called by run_save right before the request (orphan or live sender alike).
* LAST HANDED-OVER EDIT WINS, PER TARGET, within one field (id_base + lang):
*  1. an outgoing item that a NEWER pending item of another instance of the
*     field overlaps (edits_overlap) is NOT sent, and leaves the sender's
*     pending sets — a retry of an older failed edit never writes over a newer
*     one, whatever order a sweep reaches the instances in;
*  2. an OLDER pending item of another instance that an outgoing item overlaps
*     is retired (a later retry of it would write the stale value over this
*     one): every pending item of an ORPHAN, only the failed_changed_data of a
*     live sibling (its unsent edit of its own is the user's, on screen).
*     An instance left with nothing pending is deregistered — an orphan
*     retired (destroyed). An orphan registered WITHOUT items (a
*     component_password: its value is never kept) is retired by any save of
*     its field.
* Items on targets the other side does not write are never touched: a failed
* edit of value id=1 survives a newer save of value id=2. Each drop is reported
* (console.warn, with the items). Order: "newer" is the hand-over stamp
* (edit_stamp). Other instances' unseen items are stamped BEFORE the outgoing
* ones, so a fresh outgoing edit is newer than anything already pending and a
* retry (stamped when first sent) is older than an edit handed over since.
* Contract: engineering/wire_contract/WC-2026-10-30-section-record-row-box.md,
* addendum "edit-safety primitives".
*
* @param {Object} self - The instance about to send
* @param {Array<Object>} changed_data - What it is about to send
* @returns {Array<Object>} What it may send (possibly empty)
*/
const resolve_supersession = function(self, changed_data) {

	const key = field_key(self)
	if (!key) {
		stamp_edit_items(changed_data)
		return changed_data
	}

	const others = [...new Set([...get_unsaved_instances(), ...orphaned_unsaved])].filter(other =>
		other!==self &&
		other?.status!=='destroyed' &&
		field_key(other)===key
	)
	// stamp order: what is already pending elsewhere first, then the outgoing
	for (const other of others) {
		stamp_edit_items(pending_items(other))
	}
	stamp_edit_items(changed_data)
	if (others.length===0) {
		return changed_data
	}

	// 1. outgoing items a newer pending edit covers
	const newer_pending = others.flatMap(pending_items)
	const dropped = changed_data.filter(item =>
		newer_pending.some(pending => edit_stamp(pending) > edit_stamp(item) && edits_overlap(pending, item))
	)
	const outgoing = dropped.length > 0
		? changed_data.filter(item => !dropped.includes(item))
		: changed_data
	if (dropped.length > 0) {
		console.warn('[component_common] a newer pending edit of the same field supersedes items of this save', {
			field					: key,
			superseded_changed_data	: dropped
		})
		drop_pending_items(self, dropped)
	}
	if (outgoing.length < 1) {
		return outgoing
	}

	// 2. older pending edits the outgoing set covers
	for (const other of others) {

		const is_orphan		= orphaned_unsaved.has(other)
		const candidates	= is_orphan
			? pending_items(other)
			: (Array.isArray(other.failed_changed_data) ? other.failed_changed_data : [])

		// an orphan holding no items (component_password) is superseded whole
		if (is_orphan && candidates.length===0) {
			console.warn('[component_common] a newer save supersedes an orphaned unsaved edit of the same field', {
				field : key
			})
			retire_orphan(other)
			continue
		}

		const retired = candidates.filter(pending =>
			outgoing.some(item => edit_stamp(item) > edit_stamp(pending) && edits_overlap(item, pending))
		)
		if (retired.length < 1) {
			continue
		}
		console.warn('[component_common] a newer save supersedes older unsaved edits of the same field', {
			field					: key,
			orphan					: is_orphan,
			superseded_changed_data	: retired
		})
		drop_pending_items(other, retired)
		if (!has_pending_edit(other)) {
			if (is_orphan) {
				retire_orphan(other)
			} else {
				deregister_unsaved_instance(other)
			}
		}
	}

	return outgoing
}//end resolve_supersession



/**
* RETIRE_ORPHAN
* Drop an orphan whose edit will never be sent (superseded, or nothing left to
* send): out of orphaned_unsaved and the unsaved registry, pending edit
* cleared, destroyed once quiet (destroy_released_orphan). The edit is gone on
* purpose — the caller has reported why.
*
* @param {Object} orphan
* @returns {boolean} true when the instance was an orphan
*/
const retire_orphan = function(orphan) {

	const was_orphan = orphaned_unsaved_writers.delete(orphan)
	orphan.failed_changed_data = null
	if (orphan.data) {
		orphan.data.changed_data = []
	}
	deregister_unsaved_instance(orphan)
	destroy_released_orphan(orphan)

	return was_orphan
}//end retire_orphan



/**
* DESTROY_RELEASED_ORPHAN
* Destroy an orphan whose edit was just saved. Waits until the instance has no
* save or change_value in flight (change_value keeps reading self.data after
* save() returns, and destroy nulls it), then destroys it. Errors are reported,
* never thrown (fire-and-forget caller).
*
* @param {Object} self - The released orphan
* @returns {Promise<void>}
*/
const destroy_released_orphan = async function(self) {

	try {
		for (let round = 0; round < 8; round++) {
			const pending = self.saving_promise || self.change_value_promise
			if (!pending) {
				break
			}
			await pending
		}
		if (self.status!=='destroyed' && typeof self.destroy==='function') {
			await self.destroy(true, true, false)
		}
	} catch (error) {
		console.error('[component_common] could not destroy a released orphan:', self?.id, error)
	}
}//end destroy_released_orphan



/**
* GET_VALUE
* Returns the current entries array from the component's data object.
* Assumes self.data.entries is up to date (call after build() or update_datum()).
* Concrete components may override this to apply model-specific transformations.
*
* @returns {Array|null} The entries array, or null/undefined when no data is set
*/
component_common.prototype.get_value = function() {

	const value = this.data.entries

	return value
}//end get_value



/**
* SET_VALUE
* Replaces the entries array in the component's data object with the supplied value.
* This is a low-level setter: it does not trigger save(), change_value(), or any
* event. Use change_value() when a user-initiated update should be persisted.
*
* @param {Array|*} value - New entries value to assign to self.data.entries
* @returns {boolean} Always true
*/
component_common.prototype.set_value = function(value) {

	// set value in data instance
	this.data.entries = value

	return true
}//end set_value



/**
* UPDATE_DATUM
* Merges an API result object (containing fresh `data` and `context` arrays)
* into the component's shared datum, then updates self.data from the merged result.
*
* Called in two situations:
*  1. After build(autoload=true) — to push the autoloaded data into the shared datum.
*  2. After change_value() → save() — to propagate the server-returned data back
*     into datum so all other components sharing the same datum stay in sync.
*
* Data merge strategy (datum.data):
*  - Existing items are matched by (tipo, section_tipo, section_id, mode) plus,
*    for dataframe sub-entries, by (id_key, main_component_tipo), and — when both
*    sides carry the per-occurrence `caller_chain` (owner decision (b)) — only
*    when the chains are compatible; a STAMPED incoming item never matches an
*    UNSTAMPED existing one (common.same_occurrence_on_merge).
*  - Matching items have their `entries` and `fallback_value` updated in place.
*  - New items that have no match are appended to datum.data, in the order the
*    server emitted them (readers such as component_dataframe.get_rating may
*    see one component emitted once per ddo, e.g. mode 'edit' then 'solved').
*  - When new_datum.data is empty the matched item's entries are cleared to []
*    (server sends no data node when a component has no value).
*
* Context merge strategy (datum.context):
*  - Only items NOT already in datum.context are appended (no update of existing).
*  - Match is by (tipo, section_tipo, mode, lang) — added 12-10-2023 to fix
*    component_relation_parent/children visualization after adding terms — and
*    compatible `caller_chain` (per-occurrence entries, owner decision (b)).
*
* (!) datum is shared with the parent section. Portals create their own private datum.
*     Do not replace the datum reference itself — only mutate it in place.
*
* @param {Object} new_datum - API result object: { data: Array<DataItem>, context: Array<ContextItem> }
* @returns {Promise<Object|boolean>} The updated self.datum on success; false on invalid input
*/
component_common.prototype.update_datum = async function(new_datum) {

	const self = this

	// (!) Note that component datum is shared with section datum. BUT! Portals have specific datum

	const new_data		= new_datum.data
	const new_context	= new_datum.context

	// per-occurrence chains (owner decision (b)) of THIS instance's read (its own
	// get_data, its save echo) are relative to this instance: tag them with its
	// root before merging (root_caller_chains — idempotent: a response that came
	// through build_autoload is already tagged)
		root_caller_chains(new_datum, self)

	// DATA -------------------
		// new_data check
			if (!new_data || !Array.isArray(new_data)) {
				console.error(`component_common.update_datum received new_data is invalid! Expected array. Received:`, typeof new_data, new_data);
				return false
			}
			const new_data_length = new_data.length

			// EMPTY DATA CASE
			// if the caller has not data remove his value from the data
			// Server only send data when it has any data, empty portals will not send any data
			// data = []
			// the datum will remove the value of this component.
			// for now the subdatum is not removed because implications. To be evaluate.
			if(new_data_length === 0){

				for (let i = self.datum.data.length - 1; i >= 0; i--) {

					const el = self.datum.data[i]

					if( el.tipo 					=== self.tipo
						&& el.section_tipo 			=== self.section_tipo
						&& parseInt(el.section_id) 	=== parseInt(self.section_id)
						&& el.mode 					=== self.mode
						){
						// dataframe disambiguation: when the datum entry is a frame, clear ONLY the
						// entry paired with THIS item (by id_key) so sibling items' frames are never
						// wiped. Pairing identity comes from self.data.
						const el_key   = el.id_key
						const self_key = self.data?.id_key
						const to_delete = ( (el_key!==undefined && el_key!==null) && el.main_component_tipo )
							? parseInt(el_key)				=== parseInt(self_key)
								&& el.main_component_tipo	=== self.data?.main_component_tipo
							: true

						if(to_delete){
							el.entries = [];
						}
					}
				}
			}

		// datum (global shared with section)
			// DATA
			// update matching items in place; append unseen ones.
			// The loop runs from down to top (historical), so a plain push appended the
			// new items REVERSED — e.g. a rating frame child emitted [edit (datalist),
			// solved] landed as [solved, edit], and the first-match readers painted
			// from the datalist-less one. Unseen items are INSERTED at the end of the
			// pre-merge datum instead: iterating backwards, each earlier item goes in
			// front of the later ones, so the server's emission order is kept. They are
			// still in the datum while the loop runs, so a later match sees them exactly
			// as before (same in-place update semantics, only the order changed).
				const append_at = self.datum.data.length
				for (let i = new_data_length - 1; i >= 0; i--) {

					const data_item			= new_data[i]

					const ar_data_elements	= self.datum.data.filter( function(el) {
						if( el.tipo 					=== data_item.tipo
							&& el.section_tipo 			=== data_item.section_tipo
							&& parseInt(el.section_id) 	=== parseInt(data_item.section_id)
							&& el.mode 					=== data_item.mode
							// per occurrence (owner decision (b)): two items of one key stamped
							// with different parents are two occurrences, never one; a stamped
							// incoming item never merges into an UNSTAMPED one (a split that
							// first shows up in a later read — same_occurrence_on_merge)
							&& same_occurrence_on_merge(el, data_item)
							){
							// dataframe disambiguation: match the frame entry by item id (id_key)
							// so sibling items' frames are not overwritten.
							const el_key = el.id_key
							const di_key = data_item.id_key
							if( (el_key!==undefined && el_key!==null) && el.main_component_tipo ){
								return (
									parseInt(el_key)			=== parseInt(di_key)
									&& el.main_component_tipo	=== data_item.main_component_tipo
								)
							}
							return true
						}
						return false
					})

					const ar_data_el_len = ar_data_elements.length
					if (ar_data_el_len>0) {
						// update already existing data item
						for (let j = ar_data_el_len - 1; j >= 0; j--) {
							const current_data_element = ar_data_elements[j]
								  current_data_element.entries			= data_item.entries
								  current_data_element.fallback_value	= data_item.fallback_value
						}
					}else{
						// add new data item (in emission order, see append_at)
						self.datum.data.splice(append_at, 0, data_item)
					}
				}

	// CONTEXT -------------------
		// new_context check
			if (!new_context || !Array.isArray(new_context)) {
				console.error(`component_common.update_datum received new_context is invalid! Expected array. Received:`, typeof new_context, new_context);
				return false
			}
			const new_context_length = new_context.length

		// datum (global shared with section)
			// adds new elements to the datum if they do not already exist
			// Note that since 12-10-2023, the mode is taken into account here
			// New items keep the server's emission order (inserted at the pre-merge end,
			// as the DATA loop above does — a push from this backwards loop reversed them).
				const context_append_at = self.datum.context.length
				for (let i = new_context_length - 1; i >= 0; i--) {

					const context_item	= new_context[i]
					const found_item	= self.datum.context.find(el =>
						el.tipo===context_item.tipo &&
						el.section_tipo===context_item.section_tipo &&
						el.mode===context_item.mode && // @important Added 12-10-2023 because component_relation_parent/children visualization fails on add terms
 						el.lang===context_item.lang &&
						// per occurrence (owner decision (b)): an entry stamped for another
						// parent is another occurrence — keep both; a stamped entry is never
						// deduped into an UNSTAMPED one (same_occurrence_on_merge)
						same_occurrence_on_merge(el, context_item)
					)

					if (!found_item) {
						// add new context item (in emission order)
						self.datum.context.splice(context_append_at, 0, context_item)
					}
				}

	// data of multiple components (TO DELETE)
		// the data sent by the server can be data of multiple components. The new_data is an array with the all response from server.
		// When one component is observed by other and the observable component data is changed, the observer component also will change
		// It's necessary update the data in all components (self, observers), not only the caller.
			// COMMENTED 08-09-2023 BY Paco/Alex: Apparently is not necessary anymore (!)
			// const ar_instances = await get_all_instances()
			// // Iterate data and instances with equal data
			// for (let i = new_data_length - 1; i >= 0; i--) {

			// 	const data_item = new_data[i]

			// 	// find current data_intem coincident in all instances
			// 		const current_instances	= ar_instances.filter(el =>
			// 			el.tipo===data_item.tipo &&
			// 			el.section_tipo===data_item.section_tipo &&
			// 			el.section_id==data_item.section_id &&
			// 			el.lang===data_item.lang
			// 		)
			// 		const instances_length = current_instances.length

			// 		console.log('current_instances:', current_instances);
			// 		console.log('new_data data_item:', data_item);

			// 	if (instances_length>0) {

			// 		// update instance data (not for himself)
			// 		// for (let j = 0; j < instances_length; j++) {
			// 		for (let j = instances_length - 1; j >= 0; j--) {

			// 			const inst = current_instances[j]

			// 			if(inst.id === self.id) {
			// 				continue; // skip self
			// 			}

			// 			inst.data = self.datum.data.find(el =>
			// 				el.tipo===inst.tipo &&
			// 				el.section_tipo===inst.section_tipo &&
			// 				el.section_id==inst.section_id &&
			// 				el.lang===inst.lang
			// 			) || {}
			// 			// console.log("____ updated instance data:", inst);
			// 		}

			// 	}else{

			// 		// if he can't even find himself, notify to user console
			// 		console.warn(`(!) [update_datum] The instance to update from new_data was not found:
			// 			tipo: ${data_item.tipo},
			// 			section_tipo: ${data_item.section_tipo},
			// 			section_id: ${data_item.section_id},
			// 			lang: ${data_item.lang}
			// 			data_item:`,
			// 			data_item,
			// 			' in instances:',
			// 			clone(current_instances)
			// 		)
			// 	}
			// }


		// check data
			if (typeof self.data==='undefined') {
				if(SHOW_DEBUG===true) {
					console.trace();
					console.warn("++++++++++++++++++++ self.datum:",self.datum);
				}
				alert("Error on read component data!");
			}

		// add as new data the most recent changed_data
			//self.data.changed_data = changed_data

		// update element pagination vars when are used
			/*
			if (self.data.pagination && typeof self.pagination.total!=="undefined") {
				self.pagination.total = self.data.pagination.total
			}
			*/

		// dispatch event
			// event_manager.publish('update_data_'+ self.id_base, '')

	return self.datum
}//end update_datum



/**
* UPDATE_DATA_VALUE
* Applies a single ChangedDataItem mutation to self.data.entries in memory,
* without any API call. Called by change_value() before save() so the local
* model stays consistent with what will be persisted.
*
* ChangedDataItem shape:
*   {
*     action : string      — 'update' | 'set_data' | 'remove' | 'clear'
*     id     : *|undefined — stable item id; REQUIRED by 'remove' (null, undefined
*                             and '' all read as NO ID; 0 is a real id)
*     key    : number|null — legacy array index; NOT a delete target any more (see below)
*     value  : *|null      — new entry value; null signals deletion
*   }
*
* Mutation rules by action:
*   set_data                       → replace the entire entries array with `value` (bulk insert)
*   clear                          → wipe entries to [] — the deliberate wildcard,
*                                    the only wipe a record-bound instance has
*   remove + id resolved           → splice that one entry out
*   remove + id absent, mode edit  → REFUSED, see DATA-06 below
*   remove + id absent, mode search→ wipe entries to [] (clearing a filter — the
*                                    search model is transient and never saved)
*   data_key=null + value !== null → append value to entries
*   data_key=<idx> + value=null    → splice that entry out (delete by position)
*   data_key=<idx> + value !== null→ overwrite that position
*
* DATA-06 (2026-08-30) — AN UNRESOLVED ID IS NEVER A WILDCARD.
* Until this cure a remove carrying `id:null` meant "clear EVERY entry in EVERY
* language": the server's remove branch (src/core/section/record/save_component.ts)
* read `id === null` as clear-all and answered ok. The asymmetry was the defect —
* naming a WRONG id was refused and failed the save, naming NO id wiped the
* component and reported success. And `id:null` is exactly what ~20 client call
* sites produce for a SINGLE-ROW delete when the row's id is missing or 0, because
* they build it as `locator?.id || null` (component_check_box.js:168 uncheck one
* box, component_publication.js:170 alt-click remove, component_email/input_text/
* text_area `entries[key]?.id || null`, …): `0 || null` is null, and a locator not
* found in `entries` is null too. So a curator deleting ONE row could silently
* destroy the whole component in every language — irreplaceable heritage data lost
* without a single visible symptom.
* The cure is a contract, agreed with the server side: a deliberate wipe SAYS SO
* (`action:'clear'`), and a `remove` without a usable id is REFUSED here, loudly,
* before anything touches the local model or the wire. Refusing costs one failed
* click; the wildcard cost a record.
*
* THE ONE CARVE-OUT, and it is not an exception to the contract: an instance in
* `mode==='search'` holds a TRANSIENT FILTER MODEL that has no save path — it is
* read by the search builder when the SQO is assembled and then discarded. Its
* entries carry no id, so the ~7 search widgets that clear a field can only ever
* produce `remove` + `id:null`; that gesture is the curator emptying a filter, and
* it empties `entries` exactly as it always did. Refusing it there would leave the
* cleared filter in the model and RUN THE SEARCH WITH IT. The wire is protected
* regardless: `save()` refuses an id-less remove in every mode.
*
* @see component_common.prototype.save             the WIRE door, mode-independent
* @see component_publication.prototype.change_handler   the `mode==='search'` branch
*      that is the codebase's own local-vs-wire discriminator (also in
*      component_filter_records.change_handler and render_edit_component_date)
*
* id-based lookup: when `id` is present, findIndex() on entries resolves the array
* position. An id that does NOT match any loaded entry sets id_not_found and is
* left alone locally (entries may be a paginated slice — the SERVER holds the whole
* array and refuses the unknown id by itself, `remove: no item with id N`).
*
* @param {Object} changed_data_item - The mutation descriptor
* @returns {boolean} true when applied; false when REFUSED (change_value aborts
*   the save on false — the item never reaches the wire). A search-mode filter
*   clear is applied, so it returns true.
*/
component_common.prototype.update_data_value = function(changed_data_item) {

	const self = this

	// changed_data_item
		const action			= changed_data_item.action
		const changed_value		= changed_data_item.value
		// NO ID has three spellings and they mean one thing. `undefined` is what
		// JSON.stringify drops and what an omitted key reads as; `''` is an empty
		// form field and the `item.id || ''` idiom. The server's predicate
		// (unnamedRemoveRefusal, src/core/section/record/save_component.ts) refuses
		// all three, so this door must too: a shape the browser lets through does
		// not become safe, it becomes INVISIBLE — the delete dies at the wire as a
		// generic failed save instead of a message naming the cause.
		// (!) Key on the three values EXPLICITLY, never on falsiness: 0 and '0' are
		// real item ids and must stay deletable.
		const raw_id			= changed_data_item.id
		const changed_id		= (typeof raw_id==='undefined' || raw_id===null || raw_id==='')
			? null
			: raw_id

		self.data = self.data || {}

	// set_data. If action is 'set_data' the value is changed as is, exec a bulk insert or update the data of the component.
		if(action==='set_data'){
			self.data.entries = changed_value || []
			return true
		}

	// clear. THE DELIBERATE WILDCARD: wipe every entry, in every language. It is the
	// only wipe available to a record-bound instance (the search-mode filter clear
	// below is the other one, and it never leaves the browser).
	// It exists so that an intentional "reset this component" button can say what
	// it means instead of borrowing `remove` + a null id, which is also what an
	// UNRESOLVED single-row delete looks like (DATA-06, see the docblock). The two
	// are indistinguishable once they share an action, and one of them destroys a
	// record — so they no longer share one.
		if(action==='clear'){
			self.data.entries = [];
			return true;
		}

	// resolve data_key from id
	// (?? -1) because `entries?.findIndex()` yields UNDEFINED when self.data.entries
	// is missing, and `undefined !== -1` is true: without it data_key became
	// undefined and the write branch below indexed entries[undefined].
		let data_key = null;
		let id_not_found = false;
		if (changed_id !== null) {
			const idx = self.data.entries?.findIndex(entry => entry?.id === changed_id) ?? -1;
			if (idx !== -1) {
				data_key = idx;
			}else{
				id_not_found = true;
			}
		}

	// remove target guard (DATA-06). TWO different gestures arrive here as a
	// `remove` carrying no id, and only ONE of them is a delete:
	//
	//   SEARCH mode — `self.data` is a TRANSIENT FILTER MODEL, not a record. A
	//   search instance has no save path at all: every shared handler that serves
	//   both modes branches on `self.mode==='search'` to call update_data_value
	//   INSTEAD of change_value (component_publication.change_handler,
	//   component_filter_records.change_handler, render_edit_component_date's
	//   change_handler), and the search-only renderers call it directly and then
	//   merely publish 'change_search_element'. A search entry is {lang?, value?}
	//   with NO id, and those call sites build `entries[i]?.id || null` — so the id
	//   is ALWAYS null there. Emptying the filter has always meant emptying
	//   `entries`, and it still does. Refusing it would leave the CLEARED filter
	//   standing in the model and run the search with it: wrong results, not a
	//   wasted click.
	//
	//   Any other mode — the entry IS a stored row and this call is one step from
	//   the wire (change_value stops before save() on a falsy return). An unnamed
	//   remove there is the pre-2026-08-30 wildcard that wiped every entry in every
	//   language and answered success, so it is REFUSED and the user is told.
	//
	// The discriminator is the instance's OWN mode, never a flag the caller passes:
	// "the caller must remember" is the shape that produced DATA-06. And the
	// carve-out cannot reopen it, because it is local only — save() refuses an
	// id-less remove unconditionally, in every mode, so nothing accepted here can
	// reach the wire.
	// `changed_id` is 0-safe: it is null only for the three no-id spellings
	// normalised above (null, undefined, ''), so id 0 is a target like any other.
	// remove BY LOCATOR (`removes_by_locator` models only — see names_record_locator):
	// the computed entries carry no id, so the locator in `value` is the target.
	// (The flag is read FIRST: an instance without it never evaluates the helper.)
		if (action==='remove' && changed_id===null && self.removes_by_locator===true && names_record_locator(self, changed_data_item)) {
			self.data.entries = (self.data.entries || []).filter(entry => !(
				entry?.section_tipo===changed_value.section_tipo
				&& String(entry?.section_id)===String(changed_value.section_id)
			))
			return true
		}

		if (action==='remove' && changed_id===null) {

			// the transient search filter: the same wipe as action:'clear' above, on
			// a model that never leaves the browser.
			if (self.mode==='search') {
				self.data.entries = [];
				return true;
			}

			console.error('[component_common] update_data_value: REFUSED a remove with no item id — a deliberate wipe must use action:"clear"', {
				model				: self.model,
				tipo				: self.tipo,
				section_tipo		: self.section_tipo,
				section_id			: self.section_id,
				changed_data_item	: changed_data_item
			});
			// The curator MUST see this: they clicked delete and nothing was deleted.
			// A silent false would leave them believing the row is gone.
			alert('The item to remove could not be identified, so nothing was deleted.\n\nComponent: ' + (self.label || self.tipo) + '\n\nPlease reload the page and try again.');
			return false;
		}

	// data entries
		if (id_not_found===true && SHOW_DEBUG===true) {
			// Not an error here: entries can be a paginated slice. The server owns
			// the whole array and refuses an id it does not hold.
			console.warn('[component_common] update_data_value: id not found in loaded entries, deferring to the server:', changed_id, self.id);
		}
		if (data_key === null) {
			if (changed_value !== null) {
				self.data.entries = self.data.entries || [];
				self.data.entries.push(changed_value);
			}
		}else{
			if (changed_value===null && self.data.entries) {
				self.data.entries.splice(data_key, 1);
			}else{
				self.data.entries = self.data.entries || [];
				self.data.entries[data_key] = changed_value;
			}
		}

	// debug
		if(SHOW_DEBUG===true) {
			console.log('======= [component_common] update_data_value POST CHANGE:', clone(self.data.entries), self.id);
		}


	return true
}//end update_data_value



/**
* CHANGE_VALUE (AND SAVE)
* High-level user-action handler that updates the in-memory data model and
* persists the change in one atomic call. This is the correct entry point for
* all user-initiated value changes; do NOT call save() or update_data_value()
* directly from UI event handlers.
*
* Sequence:
*  1. Queue guard: if a change_value is already in progress (self.changing === true),
*     the new call is deferred into self.change_value_pool and resolved when the
*     current call drains the queue in its finally block. The flag — not the
*     'changing' status string — is the authority, because the status is briefly
*     restored around the optional refresh (step 7).
*  2. Remove-confirmation: if any item in changed_data has action === 'remove' or
*     action === 'clear', a confirmation dialog is shown (custom or default).
*     Returning false cancels.
*  3. Mark self.changing = true (and self.status = 'changing') so subsequent
*     overlapping calls queue up.
*  4. update_data_value() for each item — mutates self.data.entries in memory.
*     A falsy return ABORTS the whole call before save(): that is how a remove
*     with no item id (DATA-06) is stopped short of the wire.
*  5. save(changed_data) — POSTs to server, updates self.data and self.db_data.
*  6. For non-standalone components, update_datum() propagates the server result
*     into the shared section datum.
*  7. Optional refresh if options.refresh === true — with self.status restored to
*     its pre-change value for the duration of the call, because common.refresh
*     refuses any status but 'rendered'. An instance that was never rendered keeps
*     its real status, so refresh still refuses it. A refresh that THROWS is
*     reported (console.error) and NOT propagated: the save is already committed,
*     so the returned api_response stays the truth.
*  8. Restore status, clear self.changing and drain the queue in the finally block
*     (always runs).
*  9. Publish 'sync_data_' + id_base_lang → sibling components sharing the same
*     id_base update their DOM via events_subscription.js.
* 10. Publish 'update_value_' + id_base → ontology-defined observers react
*     (see init_events_subscription).
*
* @param {Object} options - Change descriptor
* @param {Array} options.changed_data - Array of ChangedDataItem objects (required, must be array)
* @param {string} [options.label] - Human-readable label shown in the remove confirmation dialog
* @param {boolean} [options.refresh=false] - Whether to call self.refresh() after save
* @param {boolean} [options.build_autoload=false] - autoload flag forwarded to self.refresh()
* @param {Function|boolean|undefined} [options.remove_dialog] - Custom remove-confirm function;
*   omit or pass undefined to use the built-in confirm() dialog
*
* Edit-safety (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md):
*  - self.commit_seq is incremented SYNCHRONOUSLY at entry (also for a call
*    that is queued): the row window dispatches a synthetic 'change' on an
*    editor and reads commit_seq before/after to know whether the editor
*    handed its value over.
*  - self.change_value_promise holds the running (not queued) call's promise
*    and is nulled when it resolves, identity-checked (a drained queued call
*    sets its own before the outer one resolves). A queued call does not set
*    it: change_value_pool.length already says it is pending (settle()).
*
* @returns {Promise<Object|boolean>} The api_response on success; false when cancelled or skipped
*/
component_common.prototype.change_value = function(options) {

	const self = this

	// commit_seq. The outcome signal "a value was handed over": synchronous, at
	// entry, before any guard or await.
		self.commit_seq = (Number.isInteger(self.commit_seq) ? self.commit_seq : 0) + 1

	// the call itself. (!) Kept INLINE (not a separate function): source gates
	// read the change_value body between its declaration and its end marker
	// (remove_sentinel_native: pre-flight before apply).
		const queued = (self.changing===true || self.status==='changing')
		const run_change_value = async () => {

		// queue overlapped calls to avoid server concurrence issues
		// The in-flight flag — NOT the status string — is the queue authority: the
		// status is briefly restored to its real value around the optional refresh
		// (see below), and an overlapping call arriving in that window must still
		// queue, never race the rebuild.
			if(self.changing===true || self.status==='changing') {
				//console.log(`Busy change_value delayed! ${options.changed_data.action} ${self.model}`, options.changed_data);
				return new Promise(function(resolve) {
					resolve( function_queue(self, self.change_value_pool, self.change_value, options) );
				})
			}

		// options
			const changed_data			= options.changed_data
			const label					= options.label
			const refresh				= typeof options.refresh!=='undefined' ? options.refresh : false
			const build_autoload		= typeof options.build_autoload!=='undefined' ? options.build_autoload : false
			const custom_remove_dialog	= options.remove_dialog // undefined|function|bool

		// check changed_data valid format
			if (!Array.isArray(changed_data)) {
				throw `Exception: changed_data is not as expected (array). ` + typeof changed_data;
			}

		// remove dialog. Check the remove dialog (default or sent by caller) user confirmation prevents remove accidentally
			// UIUX-01: changed_data items are objects ({action, ...}), not strings.
			// The old `changed_data[0]==='remove'` was always false, so the accidental-
			// delete confirmation never fired. Detect a remove action anywhere in the batch.
			// UIUX-02: `remove_dialog: false` means NO PROMPT, as its callers document
			// (component_select / component_radio_button clear a selection — that is an
			// edit, not a record deletion). The resolver below only ever accepted a
			// FUNCTION, so `false` fell through to the default confirm() and produced a
			// modal on every cleared select/radio — the exact opposite of the intent.
			// Only an explicit `false` skips; anything else keeps the default prompt.
			// DATA-06 (2026-08-30): 'clear' is confirmed like 'remove'. It is the more
			// destructive of the two — it wipes every entry in every language — so it
			// must never be the one action that slips past the confirmation.
			const action = changed_data[0]?.action
			if ( custom_remove_dialog!==false && changed_data.some(el => el && (el.action==='remove' || el.action==='clear')) ) {

				// generate default remove dialog to confirm the remove option is correct
				// to overwrite this dialog use something as:
				// function(){
				// 		return confirm(get_label.sure)
				// 	}
				// The confirm will check the true and false option, don't check it in the function!
				// To check the user result use the general response of this function (false or api_response)
				const remove_dialog = typeof custom_remove_dialog!=='undefined' && typeof custom_remove_dialog==='function'
					? custom_remove_dialog
					: function() {
						const safe_label = label
							? (':' + label)
							: ('from component ' + self.label)
						const msg = SHOW_DEBUG
							? `Sure to remove value ${safe_label} ? \n\nDEBUG:\nchanged_data:\n${JSON.stringify(changed_data, null, 2)}`
							: `Sure to remove value ${safe_label} ?`
						return confirm( msg )
					  }

				const remove_result = remove_dialog()
				if ( remove_result===false ) {
					return false
				}
			}

		// status
			const prev_status = self.status
			// Mark as 'changing' so overlapping change_value calls are queued (see guard
			// above) instead of racing into save() — where the second call hits the
			// `self.saving` guard, returns false and silently drops the change.
			self.changing = true
			self.status = 'changing'

		// Wrap the body in try/finally so the 'changing' status is ALWAYS restored and the
		// queued calls ALWAYS drained, even if update/save/refresh throw. Otherwise status
		// would stay 'changing' and deadlock every future change_value call.
		try {

			// update_data_value. update the component data value in the instance before to save (returns bool)
			//
			// PRE-FLIGHT THE WHOLE ARRAY, then apply. `update_data_value` could not fail
			// before 2026-08-30 — it always answered true — so this loop applied each item
			// as it went and the distinction did not exist. Now that an unresolved remove
			// is REFUSED, an aborting loop would leave items 0..i-1 already spliced into
			// `self.data.entries` with `save()` never reached: the local model mutated,
			// nothing persisted, and the refusal alert telling the curator that "nothing
			// was deleted" — false for exactly those earlier items, and the screen agreeing
			// with the alert only until the next refresh.
			//
			// Reachable through any multi-item remove set: `component_portal.unlink_record`
			// maps N locators to N removes, so one locator without an id would half-apply
			// the batch. All-or-nothing is the same shape `save()` uses one screen up, and
			// a partial local application is precisely the silent-divergence class this
			// whole change set exists to remove.
				const changed_data_length = changed_data.length
				for (let i = 0; i < changed_data_length; i++) {
					const candidate = changed_data[i]
					if (candidate && candidate.action==='remove' && is_unresolved_id(candidate.id) && !names_record_locator(self, candidate)) {
						// Same refusal the applier would raise, raised BEFORE anything moved.
						self.update_data_value(candidate)
						return false
					}
				}
				for (let i = 0; i < changed_data_length; i++) {
					const changed_data_item = changed_data[i] // must be a freeze object
					const update_data = self.update_data_value(changed_data_item)
					if (!update_data) {
						// Defensive: the pre-flight above catches the only known refusal, so
						// reaching here means a NEW one was added to update_data_value without
						// a matching pre-flight. Stop before applying more, and say so.
						console.error('[component_common] change_value: update_data_value refused item ' + i +
							' after the pre-flight passed — a refusal was added without extending the pre-flight.')
						return false
					}
				}

			// save. save and rebuild the component
				const api_response = await self.save(changed_data)

				// fix instance changed_data
				const saved_datum = response_data(api_response)
				if (saved_datum) {

					// reset component changed_data — to the still-failed items when a
				// failed edit was registered while this save was on the wire
				// (run_save kept them pending; an empty array would hide them
				// from save_unsaved_components' changed_data filter)
					self.data.changed_data = Array.isArray(self.failed_changed_data)
						? [...self.failed_changed_data]
						: []

					// update_datum. Force update datum with received API response result
					// That is necessary for example to allow update maps with ddo.hide items
					// containing coordinates value
					// @see component_geolocation tch244
					if(!self.standalone){
						await self.update_datum(saved_datum)
					}
				}

			// refresh (optional, default is false)
				if (refresh===true) {
					// common.refresh REFUSES any status but 'rendered' (it warns
					// "/// destroyed fail" and returns false). While 'changing' was held
					// across this block the refresh NEVER ran: the value was saved and the
					// component kept showing the old data until a page reload.
					// So state the truth to refresh(): the instance IS rendered right now
					// (the DOM is there) — 'changing' describes the save, not the render.
					// prev_status is restored VERBATIM, so an instance that was never
					// rendered still carries its real status and refresh still refuses it,
					// exactly as before.
					// The queueing invariant is untouched: self.changing stays true for the
					// whole try block, and the guard at the top of change_value reads THAT,
					// so an overlapping call arriving mid-refresh queues as it always did.
					self.status = prev_status
					try {
						await self.refresh({
							// build_autoload default value is false but could be a function callback
							build_autoload : build_autoload
						})
					} catch (error) {
						// A refresh that THROWS (build() failing mid-rebuild) is a failure
						// surface this call did not have before the cure: refresh used to
						// refuse instantly and return false. It is handled here, not by the
						// ~30 callers, and it is NEVER turned into a rejected change_value:
						// the save is already COMMITTED, so a rejection would tell the
						// caller "your change failed" — false, and the user would be told
						// the edit was lost. @see engineering/CONVENTIONS.md §1 (a swallow
						// is legal only when best-effort, REPORTED, and degraded-defined).
						// Degraded behaviour: the value IS saved, the component keeps
						// rendering the PREVIOUS data until something rebuilds it, and the
						// sync_data_ / update_value_ events below still publish, so siblings
						// and ontology observers are not stranded as well.
						console.error('[component_common] change_value: the value was SAVED but the component could not be refreshed', {
							model		: self.model,
							tipo		: self.tipo,
							section_id	: self.section_id
						}, error);
					}
				}

			// restore previous status value
			// (after a successful refresh the instance already re-reached 'rendered';
			// prev_status is the same value in that case)
				self.status = prev_status

			// event sync_data_ . Used to update the DOM elements of the instance
			// subscriptions from component_common.init()
			// @see events_subscription.js
				const id_base_lang = self.id_base + '_' + self.lang
				event_manager.publish('sync_data_'+id_base_lang, {
					caller			: self,
					changed_data	: changed_data
				})

			// event update_value_ . Defined in Ontology to fire events, see: hierarchy93 or numisdata77
			// subscriptions from component_common.build() -> init_events_subscription(self)
			// @see component_common.init_events_subscription
			// sample of use in Ontology item properties:
				// "observe": [
				// 	{
				// 	  "info": "Observes 'Review status' radio_button value changes to update this calculated value",
				// 	  "client": {
				// 		"event": "update_value",
				// 		"perform": {
				// 		  "function": "refresh"
				// 		}
				// 	  },
				// 	  "server": {
				// 		"filter": false
				// 	  },
				// 	  "component_tipo": "oh93"
				// 	}
				// ]
				const id_base = self.id_base
				event_manager.publish('update_value_'+id_base, {
					caller			: self
				})

			return api_response

		} finally {

			// safety: ensure status is restored even on early-return/throw.
			// UNCONDITIONAL on purpose. The old `if (self.status==='changing')` guard
			// could not fire once refresh() had begun mutating the status, so a rebuild
			// that died mid-flight left a genuinely rendered instance describing itself
			// as 'destroyed' or 'built' — and every later refresh() of it would then be
			// refused forever. prev_status is what the instance really was before this
			// save, so restoring it verbatim is both the truth and the recovery.
				self.status = prev_status

			// release the queue authority BEFORE draining, or the drained call would
			// re-queue itself and the pool would never empty (deadlock).
				self.changing = false

			// exec queue one by one
				if(self.change_value_pool.length > 0) {
					(self.change_value_pool.shift())();
				}
		}
		}//end run_change_value
		const run = run_change_value()
		if (queued) {
			// a queued call resolves through the pool (queue guard below)
			return run
		}

	// change_value_promise: present while THIS call runs
		const own = {promise: null}
		const tracked = (async () => {
			try {
				return await run
			} finally {
				if (self.change_value_promise===own.promise) {
					self.change_value_promise = null
				}
			}
		})()
		own.promise					= tracked
		self.change_value_promise	= tracked

	return tracked
}//end change_value



/**
* FUNCTION_QUEUE
* Defers a function call by wrapping it in a closure and pushing it onto a pool
* array. Used by change_value() to serialise concurrent value-change calls:
* when self.changing === true the new call is queued here and the running
* call drains it (pool.shift()()) in its finally block.
*
* (!) The queued caller does NOT get the change_value result. The wrapper
* returned here is what change_value resolves its Promise with, and
* `wrap_function` DISCARDS fn's return value — so a deferred caller resolves
* with a Function, never the api_response. `await`ing a queued change_value
* therefore says nothing about whether the save happened (a caller testing
* `api_response.result` on it is testing a property of a Function: undefined).
* Pre-existing behaviour, stated here so the comment stops asserting the
* opposite; changing it is a separate contract edit.
*
* @param {Object} context - The `this` context to bind when the function executes (usually the component instance)
* @param {Array} pool - The queue array to push the wrapped call onto
* @param {Function} fn - The function to defer (e.g. self.change_value)
* @param {Object} options - The single argument to pass when fn is eventually called
* @returns {Function} The wrapped deferred call (also added to pool)
*/
const function_queue = function(context, pool, fn, options) {

	const wrap_function = function(fn, context, params) {
		return function() {
			fn.apply(context, params);
		};
	}
	const fun = wrap_function(fn, context, [options]);

	pool.push( fun )

	return fun
}//end function_queue



/**
* UPDATE_NODE_CONTENTS
* Replaces the children of `current_node` with the children of `new_node`,
* preserving the `current_node` element itself in the DOM (so external
* references and event listeners on the container remain valid).
*
* This is preferred over `parentNode.replaceChild(new_node, current_node)` when
* the caller holds a reference to `current_node` that must stay live.
* Both nodes are mutated in place: current_node is emptied then repopulated,
* and new_node is drained (its children are moved, not copied).
*
* @param {HTMLElement} current_node - The existing container whose content will be replaced
* @param {HTMLElement} new_node - The source node whose children will be moved into current_node
* @returns {Promise<HTMLElement>} The updated current_node
*/
component_common.prototype.update_node_contents = async (current_node, new_node) => {

	// clean
		while (current_node.firstChild) {
			current_node.removeChild(current_node.firstChild)
		}
	// set children nodes
		while (new_node.firstChild) {
			current_node.appendChild(new_node.firstChild)
		}

	//current_node.parentNode.replaceChild(new_node, current_node);

	return current_node
}//end update_node_contents



/**
* CHANGE_MODE
* Switches the component to a different render mode (e.g. 'list' → 'edit') and/or
* view variant. Creates a fresh instance in the new mode, renders it, swaps it into
* the DOM in place of the old node, activates it if in edit mode, and finally
* destroys the current (old) instance.
*
* The old DOM node is preserved long enough to locate its parent for the in-place
* swap; destroy() is called with remove_dom=true so the old shadow subtree is also
* cleaned up after the swap.
*
* CSS: ontology context.css is injected by the wrapper builders
* (ui.component.build_wrapper_edit / build_wrapper_list) during render.
*
* Mode fallback logic (when options.mode is omitted):
*   list → edit (toggle to edit)
*   any other → self.mode (unchanged)
*
* View fallback logic (when options.view is omitted):
*   edit mode → 'line'
*   otherwise → self.mode (unchanged — keeps current view)
*
* @param {Object} options - Change descriptor
* @param {string} [options.mode] - Target mode ('edit', 'list', etc.). Defaults to toggling list↔edit.
* @param {string} [options.view] - Target view variant. Defaults to 'line' for edit, current mode otherwise.
* @param {boolean} [options.autoload=true] - Whether the new instance should fetch its own data
* @returns {Promise<boolean>} true on success; false when permissions are insufficient (< 1)
*/
component_common.prototype.change_mode = async function(options) {

	const self = this

	// options vars
		// mode check. When mode is undefined, fallback to 'list'. From 'list', change to 'eddit'
		const mode = (options.mode)
			? options.mode
			: self.mode === 'list' ? 'edit' : 'list'
		const view = (options.view)
			? options.view
			: mode==='edit'
				? 'line'
				: self.mode
		const autoload = (typeof options.autoload!=='undefined')
			? options.autoload
			: true

	// check interface and permissions
		if (self.permissions<1) {
			console.error('Error. calling component change_mode with permissions: ',self.permissions);
			return false
		}

	// short vars
		const current_context		= self.context
		const current_data			= self.data
		const current_datum			= self.datum
		const current_section_id	= self.section_id
		const section_lang			= self.section_lang
		const old_node				= self.node

	// id_variant. Add view_mode pattern to id variant avoiding to duplicate additions
		const pattern			= `_${view}_list|_${view}_edit`
		const regex				= new RegExp(pattern, "g");
		const id_variant_clean	= self.id_variant.replace(regex, '')
		const id_variant		= id_variant_clean + `_${view}_${mode}`

	// set the new view and mode to context
		current_context.view = view
		current_context.mode = mode

	// element. Create the instance options for build it. The instance is reflect of the context and section_id
		const new_instance = await get_instance({
			model			: current_context.model,
			tipo			: current_context.tipo,
			section_tipo	: current_context.section_tipo,
			section_id		: current_section_id,
			mode			: mode,
			lang			: current_context.lang,
			section_lang	: section_lang,
			parent			: current_context.parent,
			type			: current_context.type,
			context			: current_context,
			data			: current_data,
			datum			: current_datum,
			id_variant 		: id_variant,
			// caller. The replacement takes over self's slot in the tree, so it
			// inherits self's caller — NOT self (which is destroyed at the end of
			// this function). Tools opened from the new instance's toolbar walk
			// this chain to find their owning section; without it the chain dead-ends
			// and e.g. tool_propagate_component_data cannot resolve the section's SQO.
			caller			: self.caller
		})

	// build
		await new_instance.build(autoload)

	// caller. Re-assert AFTER get_instance: `caller` is not part of the instance
	// key (instances.js key_order) and a cache HIT returns the stored instance
	// without re-running init, so a reused instance would keep whatever caller the
	// FIRST build gave it — stale the moment a re-search rebuilds the row.
		new_instance.caller = self.caller

	// render
		const new_node = await new_instance.render({
			render_level : 'full'
		})

	// replace the node with the new render
		old_node.replaceWith(new_node);

	// active component at end
		if (mode.indexOf('edit')!==-1) {
			if (!new_instance.active) {
				ui.component.activate(new_instance)
			}
		}

	// destroy self instance (delete_self=true, delete_dependencies=false, remove_dom=false)
		self.destroy(
			true, // delete_self
			true, // delete_dependencies
			true // remove_dom
		)

	return true
}//end change_mode



/**
* CHANGE_MODE_DES
* Dead-code: superseded by change_mode(). Opened a modal instead of performing
* an in-place DOM swap. Kept commented out to preserve history.
* (!) Do not remove — explicit decision deferred.
*/
	// component_common.prototype.change_mode_DES = async function(new_mode, autoload) {

	// 	const self = this

	// 	// short vars
	// 		const current_context		= self.context
	// 		const current_data			= self.data
	// 		const current_datum			= self.datum
	// 		const current_section_id	= self.section_id
	// 		const section_lang			= self.section_lang

	// 	// element. Create the instance options for build it. The instance is reflect of the context and section_id
	// 		const new_instance = await get_instance({
	// 			model			: current_context.model,
	// 			tipo			: current_context.tipo,
	// 			section_tipo	: current_context.section_tipo,
	// 			section_id		: current_section_id,
	// 			mode			: 'edit',
	// 			lang			: current_context.lang,
	// 			section_lang	: section_lang,
	// 			parent			: current_context.parent,
	// 			type			: current_context.type,
	// 			context			: current_context,
	// 			// data			: current_data,
	// 			// datum			: current_datum
	// 		})

	// 		autoload = true

	// 	// build
	// 		await new_instance.build(autoload)

	// 	// render
	// 		const new_node = await new_instance.render({
	// 			render_level : 'full'
	// 		})

	// 	// body
	// 		const body = ui.create_dom_element({
	// 			element_type	: 'div',
	// 			class_name		: 'body section_record'
	// 		})
	// 		body.appendChild(new_node)

	// 	// modal
	// 		ui.attach_to_modal({
	// 			header				: 'Edit ' + self.label,
	// 			body				: body,
	// 			footer				: null,
	// 			size				: 'small'
	// 			// remove_overlay	: bool
	// 		})

	// 	// active component at end
	// 		// if (new_mode.indexOf('edit')!==-1) {
	// 		// 	if (!new_instance.active) {
	// 		// 		event_manager.publish('activate_component', new_instance)
	// 		// 	}
	// 		// }


	// 	return true
	// }//end change_mode_DES



/**
* SET_CHANGED_DATA
* Records a pending edit in self.data.changed_data and determines whether the
* edit represents an actual change from the last-saved server state (db_data).
*
* Deduplication: if an item with the same `id` already exists in changed_data
* it is replaced in place; otherwise the item is appended. This ensures that
* rapid keystrokes accumulate into a single pending change entry rather than
* growing the array unboundedly.
*
* Change detection: compares the new value against db_data using is_equal().
* Lookup order: by stable item `id` when present (mirrors save()'s contract),
* falling back to positional `key` when no id is set.
*
* Side effects:
*  - When the value is unchanged (is_equal returns true):
*      · retires this instance's OWN unsaved registration
*        (deregister_unsaved_instance); the derived window.unsaved_data flag
*        stays armed while other instances are still dirty
*      · removes the 'modified' CSS class from self.node
*      · returns false
*  - When the value is genuinely new:
*      · registers this instance as unsaved (register_unsaved_instance),
*        arming the derived before-unload navigation warning
*      · adds the 'modified' CSS class to self.node
*      · returns true
*
* @param {Object} changed_data_item - The change descriptor to record
* @param {*} [changed_data_item.id] - Stable item id for dedup and db lookup
* @param {number|null} [changed_data_item.key] - Array index fallback when id is absent
* @param {*} changed_data_item.value - The new value to compare against db_data
* Edit-safety: self.commit_seq is incremented synchronously at entry, as in
* change_value (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md).
*
* @returns {boolean} true when the data is genuinely changed; false when it matches db_data
*/
component_common.prototype.set_changed_data = function(changed_data_item) {

	const self = this

	// commit_seq. The outcome signal "a value was handed over" (see
	// change_value): synchronous, at entry.
		self.commit_seq = (Number.isInteger(self.commit_seq) ? self.commit_seq : 0) + 1

	// edit stamp: the hand-over order supersession compares (resolve_supersession)
		stamp_edit_items([changed_data_item])

	// changed_data. Set as empty array always
		self.data.changed_data = self.data.changed_data || []

	// set changed_data item
		const key = self.data.changed_data.findIndex(el => el.id===changed_data_item.id)
		if (key!==-1) {
			// replace
			self.data.changed_data[key] = changed_data_item
		}else{
			// add
			self.data.changed_data.push(changed_data_item)
		}

	// Check if changed_data was really changed.
	// Test if the changed_data is not the original data (the data in server database).
	// Resolve the original db entry by matching id (same contract as save()); the
	// previous code indexed db_data.entries with the changed_data array index `key`,
	// which is an unrelated ordering and compared against the wrong db entry.
		const original_value	= (changed_data_item.id !== null && changed_data_item.id !== undefined)
			? (self.db_data?.entries?.find(entry => entry?.id === changed_data_item.id) ?? null)
			: (self.db_data?.entries?.[changed_data_item.key] ?? null)
		const new_value			= changed_data_item.value

		// debug
			// console.log('original_value (DDBB):', clone(original_value));
			// console.log('new_value (changed_data_item):', clone(new_value));
			// console.log('is_equal:', is_equal(clone(new_value), clone(original_value)));

		if (is_equal(new_value, original_value)) {
			// this instance is back at its last-saved value: retire its OWN
			// unsaved registration only. (!) Never clear the page-wide flag from
			// here: window.unsaved_data is DERIVED from the events.js registry,
			// and the previous set_before_unload(false) at this spot disarmed
			// the unsaved-work guard for every OTHER dirty component on the page
			// — a one-character type-and-delete in a second field silently
			// dropped a debounced text_area edit on navigation (data loss).
			// (!) A revert is not an edit: it leaves changed_data, and so does
			// any OLDER pending item of the same target (a failed edit of this
			// very item would otherwise be retried over the value the user went
			// back to). Other pending items — another item's failed edit above
			// all — stay, and so does the registration while any is left.
			const reverted = pending_items(self).filter(item =>
				item===changed_data_item || same_edit_target(item, changed_data_item)
			)
			drop_pending_items(self, reverted)
			if (!has_pending_edit(self)) {
				deregister_unsaved_instance(self)
				self.node?.classList.remove('modified')
			}
			return false
		}

	// prevents user navigate loosing changes without warning: register this
	// instance as genuinely unsaved (window.unsaved_data derives from the registry)
		register_unsaved_instance(self)

	// add style modified to wrapper node
		if (!self.node.classList.contains('modified')) {
			self.node.classList.add('modified')
		}

	// debug
		// console.log('+++++++++++++++++++++++++++++ self.data.changed_data:', clone(self.data.changed_data));


	return true
}//end set_changed_data



/**
* CHECK_UNSAVED_DATA
* Navigation guard that flushes auto-saveable pending edits and prompts the user
* to confirm discarding any remaining unsaved changes before a navigation event
* proceeds.
*
* Two-phase approach:
*  1. If window.unsaved_data === true, call save_unsaved_components() to auto-save
*     any component instances that still carry non-empty changed_data. This handles
*     the common text-area debounce window (500 ms delay before the component marks
*     itself changed) where the user navigates faster than the debounce fires.
*     Each successful save retires its OWN registration; the sweep never wipes
*     the registry, because whatever is still registered afterwards was NOT
*     flushed: a save the server refused, a draft that is deliberately not
*     auto-saveable (component_password: a password is committed only by its
*     own Save), an instance-less assertion (set_before_unload(true)).
*     (Until 2026-09-30 the sweep called reset_unsaved_data() unconditionally,
*     so those were dropped with no prompt.) window.unsaved_data is DERIVED from
*     the events.js registry; this function never assigns the boolean directly.
*  2. Unless `flush_only`, if window.unsaved_data is still true, show a browser
*     confirm() dialog. Returning false signals the caller to abort the
*     navigation; an acceptance resets the registry — "the user accepted the
*     loss". `flush_only` callers are the in-page ones (component activation,
*     click outside components, the beforeunload handler whose native prompt
*     does the asking): they flush and never prompt, so moving between fields
*     with a pending draft does not raise a dialog.
*
* Called from:
*   page.js        — beforeunload, mousedown, user_navigation events
*   section.js     — navigate() method
*   dd-modal.js    — _closeModal() method
*   ui             — component.activate() method
*
* @param {Object} [options={}] - Options bag
* @param {string} [options.confirm_msg] - Confirmation prompt text; defaults to the
*   'discard_changes' i18n label or 'Discard unsaved changes?'
* @param {boolean} [options.flush_only=false] - Flush auto-saveable edits and return
*   true without prompting (in-page callers; see phase 2)
* @returns {Promise<boolean>} true when safe to navigate; false when the user cancelled
*/
export const check_unsaved_data = async function(options={}) {

	// options
		const confirm_msg = options.confirm_msg ||
							(get_label.discard_changes || 'Discard unsaved changes?')

	// unsaved_data case
	// Checks for unsaved components usually happens in component_text_area editions
	// because the delay (500 ms) used to set as changed
		if (typeof window.unsaved_data!=='undefined' && window.unsaved_data===true) {
			// look in all component instances for unsaved data
			await save_unsaved_components()
			// (!) no reset here: each successful save() retired its own
			// registration; what is still registered was NOT flushed and must
			// reach the prompt below, never be wiped silently.
		}

	// in-page callers: flush only, never prompt
		if (options.flush_only===true) {
			return true
		}

	// unsaved_data value check
		if (window.unsaved_data===true) {

			// let user decide if continue loosing unsaved changes
			if ( !confirm(confirm_msg) ) {
				return false
			}

			// reset unsaved_data state by the user: the user explicitly accepted
			// losing the remaining changes, so clear the whole registry and the
			// coarse assertion (derived flag goes false)
			reset_unsaved_data()
		}

	return true
}//end check_unsaved_data



/**
* SAVE_UNSAVED_COMPONENTS
* Walks the entire instance registry and calls save() on every component instance
* that has a non-empty data.changed_data array (i.e. edits not yet persisted).
*
* Called by check_unsaved_data() before presenting the user with a discard prompt,
* so that components like component_text_area — which debounce their change events
* — get a chance to flush their pending edits even when the user navigates quickly.
*
* Instances without a `data` property are skipped with a console.error (they are
* anomalous — all built components should have data) but the sweep continues for
* the remaining instances.
*
* ORPHANS (events.js orphaned_unsaved, see orphan_unsaved_instance) are swept
* too: they are outside the instance cache by design. A failed save — orphan or
* not — now registers its changed_data (save() FAILURE REGISTERS), so the
* pending-edit filter below (data.changed_data or failed_changed_data) also
* retries edits that went through change_value. An orphan superseded earlier
* in the loop is skipped; an orphan with nothing left to send is retired.
*
* @returns {Promise<boolean>} Always resolves true (individual save errors are
*   handled inside save() itself and do not abort the sweep)
*/
export const save_unsaved_components = async function() {

	// candidates: every cached instance PLUS every orphaned unsaved instance.
	// An orphan was removed from the instance cache on purpose (a rebuilt row
	// must never re-adopt it), so get_all_instances() alone would never retry
	// it. A Set: an instance is swept once. A copy: a successful orphan save
	// removes itself from orphaned_unsaved during the loop.
	// (the order does not decide which edit wins: resolve_supersession compares
	// hand-over stamps, so an older retry never writes over a newer edit)
	const snapshot_orphans	= new Set(orphaned_unsaved)
	const ar_instances		= [...new Set([...get_all_instances(), ...snapshot_orphans])]
	const ar_instances_length = ar_instances.length
	for (let i = 0; i < ar_instances_length; i++) {

		const item = ar_instances[i]
		if (item.type==='component') {
			// an orphan of the snapshot that was released or superseded meanwhile
			// (an earlier save in this very loop) is not an orphan any more:
			// never resend its edit
			if (snapshot_orphans.has(item) && !orphaned_unsaved.has(item)) {
				continue
			}
			if (!item.data) {
				console.error('))) Ignored item without data:', item);
				// skip this one but keep sweeping the rest
				continue
			}
			if (has_pending_edit(item)) {
				console.log('Saving component unsaved', item);
				// save every dirty component, not just the first one (otherwise
				// later unsaved edits are silently dropped on navigation/unload)
				await item.save()
			} else if (orphaned_unsaved.has(item) && item.model!=='component_password') {
				// an orphan with nothing left to send can never be retried, so it
				// could never leave orphaned_unsaved and would pin the unsaved
				// guard for the page's life: retire it. (!) Not a password: its
				// failed edit is registered WITHOUT changed_data on purpose
				// (register_failed_save) and only its own Save or the user's
				// discard may end it.
				console.warn('[component_common] save_unsaved_components: retiring an orphan with nothing left to send', item.id)
				retire_orphan(item)
			}
		}
	}


	return true
}//end save_unsaved_components



/**
* SETTLE
* THE "finish writing" door of a component instance
* (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md):
* resolves once nothing of this instance is in flight and its
* remaining edit, if any, was flushed. The row window awaits it before it
* releases, retires or destroys a row; it is never a reason to destroy.
*
* Loop (bounded): while a change_value (change_value_promise) or a save
* (saving_promise) is pending, await it; while the change_value pool holds a
* queued call (or a change_value is between promises), yield a macrotask so
* the running call drains it. Once quiet: if data.changed_data or
* failed_changed_data is still non-empty and the component auto-saves on deactivate (save_on_deactivate
* !== false, the same rule ui.component.deactivate applies), await ONE save().
* That save either succeeds (deregisters), short-circuits as unchanged
* (deregisters) or fails (registers, see save()).
*
* (!) Concrete components COPY prototype methods from component_common rather
* than inheriting them, so this is called as
* `component_common.prototype.settle.call(instance)` by the row window's
* edit_safety binding (it reads only instance state and the instance's own
* save()).
*
* @returns {Promise<boolean>} true when the instance holds no registered unsaved
*   change any more; false when it is still registered (failed save, refused
*   identity, a component that never auto-saves) — the caller then keeps it
*   alive (orphan_unsaved_instance), never destroys it.
*/
component_common.prototype.settle = async function() {

	const self = this

	// bound: a component that keeps re-queuing its own changes must not hang
	// a row release forever
	const max_rounds = 200

	let save_attempted	= false
	let quiet			= false
	for (let round = 0; round < max_rounds; round++) {

		// in flight: await it (a rejection is reported, the loop goes on)
		const pending = self.change_value_promise || self.saving_promise
		if (pending) {
			try {
				await pending
			} catch (error) {
				console.error('[component_common] settle: a pending write rejected', {
					model		: self.model,
					tipo		: self.tipo,
					section_id	: self.section_id
				}, error)
			}
			continue
		}

		// queued or between two promises: let the running call drain the pool
		if ((self.change_value_pool && self.change_value_pool.length > 0) || self.changing===true) {
			await new Promise(resolve => setTimeout(resolve, 0))
			continue
		}

		// quiet. Flush what is left, once.
		if (save_attempted===false && has_pending_edit(self) &&
			self.save_on_deactivate!==false && self.status!=='destroyed' && typeof self.save==='function') {
			save_attempted = true
			try {
				await self.save()
			} catch (error) {
				console.error('[component_common] settle: save rejected', {
					model		: self.model,
					tipo		: self.tipo,
					section_id	: self.section_id
				}, error)
			}
			continue
		}

		quiet = true
		break
	}

	if (quiet===false) {
		console.error('[component_common] settle: the instance never became quiet', {
			model		: self.model,
			tipo		: self.tipo,
			section_id	: self.section_id
		})
		return false
	}

	return !get_unsaved_instances().includes(self)
}//end settle



// orphan_serial. Makes every orphan's renamed id unique (orphan_unsaved_instance).
let orphan_serial = 0

/**
* ORPHAN_UNSAVED_INSTANCE
* THE one orphan operation
* (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md, addendum
* "edit-safety primitives"): a dirty instance
* whose settle() failed must outlive the row that is being torn down, without
* any later teardown being able to drop its edit, and without a rebuilt row
* ever re-adopting it.
*
*  1. spliced out of instance.caller.ar_instances — the row's destroy cascade
*     (common destroy → do_delete_dependencies) can no longer reach it, so it
*     is never deregistered by that cascade;
*  2. removed from the instance cache (delete_instance) — ONLY when the cache
*     entry is this instance. A cache hit (get_instance) would otherwise hand
*     the orphan back to the rebuilt row with its stale `caller`, and that
*     row's build(false) would reset db_data to the dirty value, so the next
*     save() would short-circuit as "unchanged" and the edit would be lost;
*  3. its `id` is renamed (the original is kept in `orphaned_id`): common
*     destroy matches the cache entry and the caller's ar_instances BY ID, so
*     the orphan's eventual destroy would otherwise evict the rebuilt row's
*     FRESH instance, which carries the same id;
*  4. DETACHED from the event bus: every token in events_tokens is
*     unsubscribed. An orphan is a pending write and nothing else. Left
*     subscribed, a sibling's sync_data_ (its renamed id defeats the
*     events_subscription echo check) would refresh it, and do_build empties
*     data.changed_data — the orphan would then hold nothing to send yet stay
*     registered for the page's life;
*  5. added to events.js orphaned_unsaved (orphaned_unsaved_writers.add) and
*     (re)registered as unsaved — the unsaved-data guard keeps counting it and
*     save_unsaved_components sweeps it. It leaves only through a successful
*     save of its own, a SUPERSESSION (newer edits of the same field cover all
*     its items, see resolve_supersession; or the sweep finds nothing left to
*     send) or reset_unsaved_data (the user's discard), and is destroyed then.
* Idempotent.
*
* @param {Object} instance - The dirty component instance to orphan
* @returns {boolean} true when the instance is (now) an orphan
*/
export const orphan_unsaved_instance = function(instance) {

	if (!instance || typeof instance!=='object') {
		return false
	}
	if (orphaned_unsaved.has(instance)) {
		return true
	}

	// 1. out of the caller's ar_instances
		const caller_instances = instance.caller?.ar_instances
		if (Array.isArray(caller_instances)) {
			const index = caller_instances.indexOf(instance)
			if (index!==-1) {
				caller_instances.splice(index, 1)
			}
		}

	// 2. out of the instance cache (never evicting another instance)
		const key = instance.id
		if (key && get_instance_by_id(key)===instance) {
			delete_instance(key)
		}

	// 3. a key of its own
		orphan_serial++
		instance.orphaned_id	= key
		instance.id				= `${key}__orphan_${orphan_serial}`

	// 4. off the event bus (destroy would do the same; the orphan is not
	// destroyed, so do it now)
		const tokens = Array.isArray(instance.events_tokens) ? instance.events_tokens : []
		for (let i = tokens.length - 1; i >= 0; i--) {
			event_manager.unsubscribe(tokens[i])
		}
		tokens.length = 0

	// 5. kept, counted, swept — its pending items stamped now at the latest, so
	// any edit a rebuilt row hands over later is NEWER (resolve_supersession)
		stamp_edit_items(pending_items(instance))
		orphaned_unsaved_writers.add(instance)
		register_unsaved_instance(instance)


	return true
}//end orphan_unsaved_instance



/**
* DEACTIVATE_COMPONENTS
* Click-away handler attached to the document (and to section wrappers in edit mode)
* that deactivates the currently active component when the user clicks outside it.
*
* Two code paths:
*  A. A component is currently active (page_globals.component_active is set):
*     - If component locking is enabled (DEDALO_LOCK_COMPONENTS === true) and the
*       component is in edit mode, a background worker request is fired via
*       dd_request_idle_callback to send a 'blur' lock-state update to the server
*       (preventing the record from appearing locked to other users after the focus
*       leaves without an explicit save).
*     - ui.component.deactivate() is called to visually deactivate the component.
*  B. No component is active:
*     - check_unsaved_data() is called to handle the text-area debounce window edge
*       case where the user clicks outside any component before the debounce timer fires.
*
* Scrollbar clicks: e.target.parentElement === null means the click landed on the
* browser scrollbar (which is outside the DOM tree). These are ignored to prevent
* spurious deactivation when the user scrolls the page.
*
* Called from:
*   view_default_edit_section → render (section-level mousedown listener)
*   page.js document-level mousedown listener
*
* @param {MouseEvent} e - The originating mouse event
*/
export const deactivate_components = function(e) {
	e.stopPropagation()

	// click on scrollbar case: capture event
		const is_descendant_of_root = (e.target.parentElement !== null);
		if (is_descendant_of_root===false) {
			return
		}

	if (page_globals.component_active) {

		const component_instance = page_globals.component_active

		// lock_component. launch worker
			if (DEDALO_LOCK_COMPONENTS===true && component_instance.mode==='edit') {
				dd_request_idle_callback(
					() => {
						data_manager.request({
							use_worker	: true,
							body		: {
								dd_api			: 'dd_utils_api',
								action			: 'update_lock_components_state',
								prevent_lock	: true,
								options			: {
									component_tipo	: component_instance.tipo,
									section_tipo	: component_instance.section_tipo,
									section_id		: component_instance.section_id,
									action			: 'blur' // delete_user_section_locks | blur | focus
								}
							}
						})
						.then(function(api_response) {
							// update page_globals
							page_globals.dedalo_notification = api_response.dedalo_notification || null
							// dedalo_notification from config file
							event_manager.publish('dedalo_notification', page_globals.dedalo_notification)
						})
					}
				)
			}

		// deactivate
			ui.component.deactivate(component_instance)
	}else{

		// unsaved_data case
		// This allow catch page mousedown event (outside any component) and check for unsaved components
		// usually happens in component_text_area editions because the delay (500 ms) to set as changed
			check_unsaved_data({flush_only: true})
	}
}//end deactivate_components



/**
* DATAFRAME
* get_dataframe, delete_dataframe, and attach_item_dataframe were extracted to
* dataframe.js to centralise the dataframe pairing contract in a single authority
* file. They are re-exported here so that existing callers importing from
* component_common.js continue to work without changes.
*
* @see core/component_common/js/dataframe.js for full documentation and the
*   pairing contract (id_key / main_component_tipo).
*/
export { get_dataframe, delete_dataframe, attach_item_dataframe } from './dataframe.js'



/**
* IS_EMPTY
* Determines whether a component instance currently holds no user data.
* Used by the search-mode event handler in events_subscription.js to decide
* whether to highlight (hilite) the component wrapper.
*
* Resolution order:
*  1. If instance is falsy → true (empty).
*  2. If the instance defines its own `is_empty()` method, delegate to it.
*     Concrete components that have unusual data shapes (e.g. component_date,
*     component_select) override this to apply model-specific logic.
*  3. Otherwise apply the shared heuristic:
*     - entries array empty → true
*     - entries[0] is an object with a 'value' property (string-component shape) →
*       empty when value is falsy or ''
*     - entries[0] is any other truthy value → false (non-empty)
*     - entries[0] is falsy → true
*
* @param {Object|null} instance - The component instance to check
* @returns {boolean} true when the instance has no meaningful data
*/
export const is_empty = function( instance ) {

	if( !instance ) {
		return true
	}

	if( typeof instance.is_empty === 'function' ) {
		return instance.is_empty()
	}

	const entries = instance.data?.entries || []

	if(entries.length === 0) {
		return true
	}

	const entries0 = entries[0]
	if(entries0 && typeof entries0 === 'object' && Object.prototype.hasOwnProperty.call(entries0, 'value')) {
		// string components check
		return !entries0.value || entries0.value === ''
	}else{
		// other components check
		if(entries0) {
			return false
		}
	}

	return true;
}//end is_empty



/**
* CAN_EDIT_IN_LIST
* Whether a list-mode component opens its editor on click: not read-only, with
* write permission, and not inside a dataframe.
* @param {Object} self - The component instance
* @returns {boolean}
*/
const can_edit_in_list = (self) => {
	return self.show_interface.read_only !== true
		&& self.permissions >= 2
		&& !ui.inside_dataframe(self)
}//end can_edit_in_list



/**
* BIND_EDIT_IN_LIST
* Wires a list-mode component's wrapper to its editor: a click opens it
* (activate_edit_in_list), and the click does not bubble (the row / section
* behind must not react).
* An editable cell inside an EDIT component (a list cell of a portal) also
* keeps its MOUSEDOWN: the container activates on mousedown (ui.js
* build_wrapper_edit), so without this a click that opens the cell's edit
* modal also activated the portal behind it (tools pill, search bar). A
* read-only cell lets it through: there, clicking it activates the portal,
* as clicking any other part of it does.
*
* @param {Object} self - The component instance
* @param {HTMLElement} wrapper - The list wrapper (ui.component.build_wrapper_list)
* @param {Object} [options] - activate_edit_in_list options
* @returns {void}
*/
export const bind_edit_in_list = (self, wrapper, options={}) => {

	wrapper.addEventListener('mousedown', (e) => {
		if (can_edit_in_list(self) && wrapper.parentElement?.closest('.wrapper_component.edit')) {
			e.stopPropagation()
		}
	})

	wrapper.addEventListener('click', (e) => {
		e.stopPropagation()
		activate_edit_in_list(self, e, options)
	})
}//end bind_edit_in_list



/**
* ACTIVATE_EDIT_IN_LIST
* Unified edit mechanism for components in list view.
* Handles permissions, read-only mode, dataframe context, and edit mode selection.
*
* @param {Object} self - The component instance
* @param {Event} e - The mouse event for positioning the modal
* @param {Object} options - Optional configuration
* @param {string} options.mode - 'modal' (always modal), 'inline' (always inline), 'auto' (based on width)
* @param {string} options.inline_view - View to use for inline mode (default: 'line')
* @param {string} options.modal_width - Modal width CSS value (default: '25rem')
* @param {string} options.lang - Language to use for edit instance
* @param {Function} options.on_close - Callback when modal closes
* @returns {boolean|undefined} false if read-only or inside dataframe; undefined otherwise (edit is launched)
*
* @example
* // Simple usage (auto mode)
* wrapper.addEventListener('click', (e) => {
*   e.stopPropagation()
*   activate_edit_in_list(self, e)
* })
*
* @example
* // Always modal with custom width
* wrapper.addEventListener('click', (e) => {
*   e.stopPropagation()
*   activate_edit_in_list(self, e, { mode: 'modal', modal_width: '90%' })
* })
*
* @example
* // Auto mode with custom inline view
* wrapper.addEventListener('click', (e) => {
*   e.stopPropagation()
*   activate_edit_in_list(self, e, { mode: 'auto', inline_view: 'line' })
* })
*/
export const activate_edit_in_list = (self, e, options={}) => {

	// options
		const mode			= options.mode ?? 'modal' // 'modal' | 'inline' | 'auto'
		const inline_view	= options.inline_view ?? 'line'
		const modal_width	= options.modal_width ?? '25rem'
		const lang			= options.lang ?? null
		const on_close		= options.on_close ?? null

	// read only / dataframe
		if (!can_edit_in_list(self)) {
			return false
		}

	// resolve edit mode
		const edit_mode = (() => {
			if (mode === 'modal') return 'modal'
			if (mode === 'inline') return 'inline'
			// auto: decide based on wrapper width
			if (mode === 'auto') {
				const wrapper_width = e.target?.getBoundingClientRect?.()?.width
					|| e.currentTarget?.getBoundingClientRect?.()?.width
					|| 0
				const minimum_width = self.minimum_width_px ?? 200
				return wrapper_width >= minimum_width ? 'inline' : 'modal'
			}
			return 'modal' // fallback
		})()

	// execute edit mode
		if (edit_mode === 'inline') {
			// inline way: change mode directly
			self.change_mode({
				mode	: 'edit',
				view	: inline_view
			})
		} else {
			// modal way: open modal to edit
			ui.render_edit_modal({
				self		: self,
				lang		: lang,
				callback	: (dd_modal) => {
					dd_modal.modal_content.style.width = modal_width
					// 'center' class from render_edit_modal handles both horizontal and vertical centering
				},
				on_close	: on_close
			})
		}
}//end activate_edit_in_list



// @license-end
