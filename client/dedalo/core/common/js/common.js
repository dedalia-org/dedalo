// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEBUG, Promise, DEDALO_ROOT_WEB, JsonView, get_label, SHOW_DEVELOPER, Promise */
/*eslint no-undef: "error"*/



// imports
	import {clone, load_style, load_script, strip_tags} from '../../common/js/utils/index.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {delete_instance} from '../../common/js/instances.js'
	import {dd_request_idle_callback, deregister_unsaved_instance, deregister_uncommitted_input} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {get_inserted_rules} from '../../page/js/css.js'
	import {render_stream} from '../../common/js/render_common.js'
	// error system (api_error.js → error_policy.js → error_dispatch.js → render_api_error.js).
	// The cycle common ↔ render_api_error (format_label) is resolved at call time:
	// nothing here is used while the modules evaluate.
	// (!) ApiError + CLIENT_ERROR are USED HERE (the missing-context branch of
	// render() builds one). They were referenced without being imported until
	// 2026-09-04 (P2-25 / DEAD-07 gate): the branch threw ReferenceError instead
	// of rendering the error panel it promises.
	import {ApiError, CLIENT_ERROR, is_api_error, request_failed, response_data} from '../../common/js/api_error.js'
	import {handle_api_error, is_page_identity_revoked} from '../../common/js/error_dispatch.js'
	import {render_error_panel, render_build_failure, error_text, error_debug_suffix} from '../../common/js/render_api_error.js'



/**
* COMMON
* Base constructor and shared prototype methods for every Dédalo UI instance
* (components, sections, areas, portals).
*
* All Dédalo UI elements extend this base via prototype assignment. The lifecycle
* for every instance follows a strict state machine:
*
*   init → build → render → (refresh cycles: destroy deps → build → render) → destroy
*
* Status values: 'initializing' → 'initialized' → 'building' → 'built'
*                → 'rendering' → 'rendered' → 'destroyed'
*
* Exported prototype methods (mixed into every Dédalo element class):
*   init, build, render, refresh, destroy, lock_rows, build_rqo_show, build_rqo_search,
*   load_data_from_datum, get_section_elements_context, calculate_component_path
*
* Exported stand-alone helpers:
*   set_context_vars, create_source, get_columns_map, get_ar_inverted_paths,
*   caller chain (nested-ddo_map plan W4/W5): create_callers,
*   get_component_ancestors, get_caller_chain_tipos, root_caller_chains,
*   select_by_caller_chain, caller_chains_compatible, same_occurrence_on_merge,
*   load_data_debug, render_tree_data, validate_tipo, get_fallback_value,
*   push_browser_history, build_autoload, set_environment, update_process_status
*   row windows (WC-2026-10-30-section-record-row-box): lock_rows,
*   resolve_pending_rows, log_pending_rows, destroy_row_windows,
*   destroy_unwindowed_dependencies, place_list_after
*/
export const common = function(){

	return true
}//end common



/**
* INIT
* Shared initializer for all Dédalo instances (components, sections, areas, portals).
* Seeds every well-known property from `options` to a consistent baseline so that
* downstream lifecycle methods (build, render) can assume they exist.
*
* (!) For components, always call component_common.init() — not this function directly.
* component_common.init() calls this internally and adds component-specific setup on top.
*
* Sets `this.is_init = true` as a one-shot guard: a second call to init() on the
* same instance is treated as a programming error and logs a console error.
*
* Properties seeded here (all sourced from `options`):
*   model, tipo, section_tipo, section_id, mode, lang, type,
*   context, data, datum, rqo, properties, view, render_level,
*   caller, standalone, events_tokens (empty array), ar_instances (empty array),
*   node (null — populated during render).
*
* @param {Object} options - Initialization options bag
* @param {string} options.model - Component/section class name, e.g. 'component_input_text'
* @param {string} options.tipo - Ontology tipo of this instance, e.g. 'dd345'
* @param {string} options.section_tipo - Ontology tipo of the parent section, e.g. 'oh1'
* @param {string|number} options.section_id - Record identifier within the section
* @param {string} options.mode - Render mode: 'edit', 'list', 'search', etc.
* @param {string} options.lang - Active language tag, e.g. 'lg-eng'
* @param {string} [options.type] - Instance type classifier: 'component', 'section', 'area', etc.
* @param {Object|null} [options.context=null] - Server-resolved context (properties, tools, permissions, etc.)
* @param {Object|null} [options.data=null] - Resolved component data for the current record
* @param {Array|null} [options.datum=null] - Full datum array including dependent data (portals, etc.)
* @param {Object} [options.rqo] - Pre-built request query object for this instance
* @param {Object} [options.properties] - Instance-specific configuration properties
* @param {string} [options.view] - View variant to use, e.g. 'default', 'list'
* @param {Object|null} [options.caller=null] - Parent instance that owns this instance
* @param {boolean} [options.standalone=true] - Whether the instance manages its own lifecycle
* @returns {Promise<boolean>} true on success; false if the instance was already initialized
*/
common.prototype.init = async function(options) {

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
		self.mode			= options.mode // current component mode like 'edit'
		self.lang			= options.lang // current component lang like 'lg-nolan'

	// type
		self.type 			= options.type

	// optional vars
		self.context		= options.context	|| null // structure context of current component (include properties, tools, etc.)
		self.data			= options.data		|| null // current specific data of this component
		self.datum			= options.datum		|| null // global data including dependent data (used in portals, etc.)

	// rqo - optional, used to define specific rqo for the instance, used in dd_grid (every dd_grind is loaded with specific rqo)
		self.rqo			= options.rqo

	// properties
		self.properties		= options.properties

	// var containers
		self.events_tokens	= [] // array of events of current component
		self.ar_instances	= [] // array of children instances of current instance (used for autocomplete, etc.)

	// DOM
		self.node			= null // component node place in light DOM

	// view
		self.view			= options.view

	// render_level
		self.render_level	= null

	// caller pointer
		self.caller			= options.caller || null

	// standalone
		self.standalone		= options.standalone ?? true


	// status update
		self.status = 'initialized'


	return true
}//end common.prototype.init



/**
* BUILD
* Shared build stub for instances that do not override this method.
* Most concrete classes (component_common, section, area, portal) replace this with
* their own `build` that calls the API, hydrates context/data, and sets up events.
*
* This base version simply transitions status from 'building' → 'built' and publishes
* the 'built_<id>' event so any in-progress render() waiters can continue.
*
* Concurrency guard: if `status === 'building'`, returns the existing `_build_waiter`
* Promise so multiple concurrent callers share one build result instead of racing.
*
* (!) For components, always call component_common.build() — not this base directly.
*
* @param {boolean} [autoload=false] - When true, instructs the overriding build to
*   fetch context and data from the API. Ignored in this base stub.
* @returns {Promise<boolean>} Resolves to true once the instance reaches 'built' status
*/
common.prototype.build = async function(autoload=false) {

	const self = this

	// check status
		switch (self.status) {
			case 'building':
				return self._build_waiter;
			case 'built':
				return true;
		}

		self.status = 'building'
		self._build_waiter = new Promise(async (resolve) => {

			// status update
			self.status = 'built'
			event_manager.publish('built_' + self.id, self)
			resolve(true)
		})

	return self._build_waiter
}//end common.prototype.build



/**
* SET_CONTEXT_VARS
* Wire up `self.context` properties as live getter/setter pairs and establish
* the instance-level `show_interface` configuration object.
*
* Called once per instance during the `build` phase, after context has been
* loaded from the API. Its key responsibilities:
*
* 1. Copy top-level context scalars (type, label, tools) onto `self`.
* 2. Replace `self.view` and `self.properties` with Object.defineProperty
*    getter/setters backed by `self.context`, so writes to `self.view` are
*    immediately reflected in the context object (and vice-versa).
* 3. Build `self.show_interface` by merging the component's context/request-config
*    override with `default_show_interface`. Any key absent in the override is
*    filled from the default, so callers can rely on every flag being present.
*    The override is CLONED first: `show_interface` is instance-owned, so the
*    render paths that write flags into it never mutate the source
*    `context.properties.show_interface` / `request_config_object.show.interface`.
* 4. Attach `self.rqo_test` as a lazy getter (via Object.defineProperty) that
*    constructs a minimal debug RQO on first access without eagerly computing it.
*
* The `view` / `properties` / `permissions` proxy pattern ensures that changing
* `self.view = 'list'` inside a render method also updates `self.context.view`,
* keeping the context object as the single source of truth for serialization.
*
* @param {Object} self - The Dédalo instance to configure (component, section, etc.)
* @returns {boolean} true
*/
export const set_context_vars = function(self) {

	if (self.context) {
		self.type			= self.context.type // typology of current instance, usually 'component'
		self.label			= self.context.label // label of current component like 'summary'
		self.tools			= self.context.tools || [] //set the tools of the component
		// self.permissions	= self.context.permissions || 0

		// view. Swaps the value with the context value and makes it a getter/setter of the context value
		// this allow sync self.view and self.context.view after building the instance
			self.view = self.context.view || self.view
			Object.defineProperty(self, 'view', {
				get : function() {
					return self.context?.view || null
				},
				set : function(value) {
					self.context.view = value;
				}
			});

		// properties. Swaps the value with the context value and makes it a getter/setter of the context value
		// this allow sync self.properties and self.context.properties after building the instance
			self.properties = self.context.properties || self.properties
			Object.defineProperty(self, 'properties', {
				get : function() {
					return self.context?.properties || null
				},
				set : function(value) {
					self.context.properties = value;
				}
			});

			self.permissions = self.context.permissions || self.permissions
			Object.defineProperty(self, 'permissions', {
				get : function() {
					return self.context?.permissions || 0
				},
				set : function(value) {
					self.context.permissions = value
				}
			});

		// show_interface. object . Defines useful view custom properties to take control
		// of some common component behaviors
		// if show_interface is defined in properties used the definition, else use this default
			const default_show_interface = {
				read_only						: false, // bool false
				save_animation					: true, // bool true
				// buttons_container			: true, // bool false
				value_buttons					: true,  // bool true
				button_add						: true, // bool true (on get_buttons function)
				button_delete					: true, // bool true (trash can)
				button_delete_link				: true, // bool true (modal option to remove portal link only)
				button_delete_link_and_record	: true, // bool true (modal option to remove portal link and his target record)
				button_link						: true, // bool true (portal button to link with another sections)
				button_edit						: false, // bool false. (ex. component_select User profile (dd1725) inside value)
				button_list						: true, // bool true (ex. component_radio_button: to go to target section)
				button_edit_options				: {
					action_mousedown	: 'navigate', // string navigate|open_window (name of function to exec)
					action_contextmenu	: 'open_window' // string open_window (name of function to exec)
				},
				tools							: true, // bool true
				button_external					: false, // bool false
				button_tree						: false, // bool false
				button_fullscreen				: true, // bool false
				button_save						: true, // bool true (used by component_geolocation, text_area...)
				show_autocomplete				: true, // bool true
				show_section_id					: true, // bool true
				list_from_component_data 		: true, // bool true
				label 							: true // bool true
			}
			// set the instance show_interface
			self.show_interface = (!self.context.properties?.show_interface && !self.request_config_object?.show?.interface)
				? default_show_interface
				: (()=>{
					// clone: never mutate the source context / request_config object
					const new_show_interface = {
						...((self.context.properties.show_interface)
							? self.context.properties.show_interface
							: self.request_config_object.show.interface)
					}
					// add missing keys
					for (const [key, value] of Object.entries(default_show_interface)) {
						if (new_show_interface[key]===undefined) {
							new_show_interface[key] = value
						}
					}

					return new_show_interface
				  })()

		// getters
			// const ar_getters = [
			// 	'type',
			// 	'label',
			// 	'tools',
			// 	'permissions',
			// 	'view'
			// ]
			// const ar_getters_length = ar_getters.length
			// for (let i = 0; i < ar_getters_length; i++) {
			// 	const name = ar_getters[i]
			// 	// if (self[name]) {
			// 	// 	// console.warn('ignored already set context getter assign:', name, self.status, self.model);
			// 	// 	continue;
			// 	// }
			// 	// if (!self.hasOwnProperty(name)) {
			// 		Object.defineProperty(self, name, {
			// 			get : function() {
			// 				return self.context[name];
			// 			},
			// 			set : function(value) {
			// 				return self.context[name] = value;
			// 			}
			// 		});
			// 	// }
			// }
			// console.log('self.label:', self.label, self.model, self.context);
	}

	// rqo_test. Used to simulate component call to API to load data and context
		if (!self.hasOwnProperty('rqo_test')) {
			Object.defineProperty(self, 'rqo_test', {
				get : function() {
					return get_rqo_test(self);
				}
			});
		}


	return true
}//end set_context_vars



/**
* RENDER
* Main render dispatcher for all Dédalo UI instances. Delegates to the
* instance's mode-named method (e.g. `self.edit()`, `self.list()`) and
* manages DOM replacement and lifecycle state transitions.
*
* Render levels:
*   'full'    — creates the complete wrapper DOM tree and stores it in `self.node`.
*               If a previous `self.node` already exists in the DOM, it is replaced
*               via `replaceWith()` to keep the parent tree consistent.
*   'content' — only regenerates the inner `content_data` sub-node and splices it
*               in-place, leaving the wrapper intact. Used by refresh() to avoid
*               full teardown on data updates.
*
* Concurrency / status machine:
*   'building'  → waits for 'built_<id>' event, then re-calls render()
*   'built'     → normal path; proceeds immediately
*   'rendering' → smart concurrency:
*       - Identical (render_level + render_mode) → joins the in-progress waiter
*       - Different request (LWW) → queues latest options; triggers after current render
*   'rendered'  → if same render_level, returns existing node with a warning
*
* Pre-render guards (short-circuit to an error/empty node):
*   - page_globals.page_error is set and self is page scope (is_page_root) → renders the error panel
*   - the last build_autoload failed (status 'initialized' + build_error) → renders that failure (render_build_failure)
*   - type === 'component' and context is falsy → renders "invalid context" error
*   - permissions < 1 → renders a "no access" span
*
* Post-render:
*   - Publishes 'render_<id>' event with the result node
*   - In 'edit' mode, schedules tooltip activation via dd_request_idle_callback
*
* @param {Object} [options={}] - Render options bag
* @param {string} [options.render_mode] - Mode override; defaults to `self.mode`.
*   Falls back to 'list' if no matching render method exists on the instance.
* @param {string} [options.render_level='full'] - Depth of render: 'full' or 'content'
* @returns {Promise<HTMLElement|boolean>} The rendered DOM node, or false on error/skip
*/
common.prototype.render = async function (options={}) {
	// const t0 = performance.now()

	const self = this

	// options
		const render_mode	= options.render_mode || self.mode
		const render_level	= options.render_level || 'full' // full|content

	// render mode. Method name is element node like 'edit' or 'list'. If not exists, fallback to 'list'
		const current_render_mode = (typeof self[render_mode]==='function')
			? render_mode
			: 'list'

	// page error case
	// page_globals.page_error is the ONE page-level failure (an ApiError set by
	// error_dispatch / page.build). It replaces only a PAGE-scope render (the
	// page, a page-root element): an embedded sibling (an inspector's
	// relation_list, a portal, a side panel) keeps rendering its own node —
	// swapping every instance on the page for the panel is what left the page
	// stuck after one refusal.
		if (page_globals.page_error && is_page_root(self)) {

			// debug
			console.warn('))) render page_globals.page_error:', self.model, page_globals.page_error);

			self.node = render_error_panel(page_globals.page_error)

			return self.node
		}
	// failed build case
	// The last build_autoload FAILED: status is back to 'initialized' and the
	// request's ApiError is kept on build_error. A render of that instance IS the
	// failure, drawn in place (render_build_failure). An embedded refusal reaches
	// neither the page slot nor a toast (render_scoped_panel, page_scope:false),
	// so a caller that ignores build()===false and renders anyway (the TM tool's
	// list, a portal) must still show it — never a blank or crashed list. A
	// page-scope page-panel refusal already returned above.
		if (self.status==='initialized' && is_api_error(self.build_error)) {

			self.node = render_build_failure({instance: self})

			return self.node
		}
	// context check
		if (self.type==='component' && !self.context) {
			return render_error_panel(new ApiError({
				code	: CLIENT_ERROR.BAD_RESPONSE,
				message	: 'Unable to render component without context'
			}))
		}

	// permissions check
		const permissions = parseInt(self.permissions)
		if(parseInt(permissions)<1) {

			const label = (get_label.no_access || 'You don\'t have access here')
						+ ' [' + self.tipo + ']'
			const node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'no_access',
				text_content	: label
			})
			self.node = node

			return node
		}

	// previous status
		const previous_status = clone(self.status)

	// status check to prevent duplicated actions
		switch(self.status) {

			case 'building':
				// Wait for build to finish before rendering
				return new Promise(resolve => {
					event_manager.subscribe_once('built_' + self.id, () => {
						resolve(self.render(options))
					})
				})

			case 'built':
				// all is as expected. Continue executing normally
				break;

			case 'rendering':
				// Ensure we have a waiter promise for this in-progress render
				if (!self._render_waiter) {
					self._render_waiter = new Promise(resolve => {
						event_manager.subscribe_once('render_' + self.id, (result_node) => {
							self._render_waiter = null;

							const pending_options = self._pending_render_options;
							self._pending_render_options = null;

							if (pending_options) {
								// Trigger next queued render. Force 'built' (previous_status here is
								// 'rendering', which would re-enter the waiter case and deadlock)
								self.status = 'built';
								resolve(self.render(pending_options));
							} else {
								resolve(result_node);
							}
						});
					});
				}

				// Smart Concurrency logic to avoid race conditions and redundant renders
				// 1. Identical request joining: If the new request matches the active one, join the existing waiter
				if (self._rendering_params &&
					self._rendering_params.render_level === render_level &&
					self._rendering_params.current_render_mode === current_render_mode) {
					return self._render_waiter;
				}

				// 2. Different request queuing (LWW): Store latest options and wait for current render to finish
				self._pending_render_options = options;

				return self._render_waiter;

			case 'rendered':
				// if render mode is equal than current already rendered node, return node
				if (self.render_level===render_level) {
					if (self.node) {
						if (self.model!=='component_filter') {
							console.warn(`Render unexpected status (rendered). Returning already rendered node (${self.model}).
							Expected status is 'built' but current is: '${clone(self.status)}'`, render_level, self.model, self.id);
						}
						return self.node
					}else{
						console.warn(`Render unexpected status. Rendered node not found but status is rendered:`, self.node, self.id);
						return false
					}
				}
				break;

			default:
				if (self.render_level===render_level) {
					// event_manager.subscribe('built_'+self.id, self.render.edit(options))
					console.warn(`Render illegal status '${self.status}'. Returning 'false'. Expected 'built' current is:`, clone(self.status), render_level, self.model, self.id);
					return false
				}
				break;
		}//end switch status

	// status update
		self.status = 'rendering'
		self._rendering_params = { render_level, current_render_mode }

	// fix current render level
		self.render_level = render_level

	// self data verification before render
		//if (typeof self.data==="undefined") {
		//	console.warn("self.data is undefined !! Using default empty value for render");
		//	self.data = {
		//		value : []
		//	}
		//}
		//console.log("typeof self[render_mode]:",typeof self[render_mode], self.model);

		// warning when fallback render mode
			if (current_render_mode!==render_mode) {
				// (The 'tm' exemption is gone with the render mode itself —
				// WC-2026-08-14-tm-ddo-mode-retired. Nothing renders in 'tm' now, so
				// any fallback reaching here is a genuine misconfiguration.)
				console.warn(`Invalid render_mode '${render_mode}', falling back to 'list'.`);
			}

		// render options
			const render_options = Object.assign({
				render_level	: render_level,
				render_mode		: render_mode
			}, options)

		// render function handler check
			if (typeof self[current_render_mode]!=='function') {
				console.warn(`Render function not defined: ${current_render_mode}`);
				self.status = previous_status // Reset status on error
				self._rendering_params = null
				return false;
			}

		const node = await self[current_render_mode](render_options);

	// result_node render based in render_level
		const result_node = await (async () => {

			// render_level
			switch(render_level) {

				case 'content': {

					// replace instance content_data node
						const wrapper = self.node

					// current instance content_data node
						const old_content_data_node	= wrapper?.content_data

						// warning if not found
						if (!old_content_data_node) {

							console.error("Invalid content_data pointer node found in render ("+self.model+") :", typeof old_content_data_node, old_content_data_node, self);

							// new warning content_data node is added
								const label = 'Invalid content_data DOM node [' + self.tipo + ']'
								const new_content_data_node = ui.create_dom_element({
									element_type	: 'div',
									class_name		: 'no_access',
									text_content	: label
								})
								requestAnimationFrame(()=>{
									self.node.appendChild(new_content_data_node)
								})
								// set pointers
								self.node.content_data = new_content_data_node

							return self.node
						}

					// new content data node
						const new_content_data_node = node
							? node // use already calculated node
							: await self[render_mode](render_options);

					// replace
						old_content_data_node.replaceWith(new_content_data_node);
						// set pointers. Update the wrapper pointer to the new content_data node
						self.node.content_data = new_content_data_node

					// list_after. The one non-row sibling slot travels with its
					// content_data (strict no-op when neither pointer exists)
						place_list_after(wrapper, new_content_data_node)

					// return created node (content_data)
					return self.node
				}

				case 'full':
				default:

					// set
						// replaces DOM node if the node exist,
						// ex: when it's called by event that need change data in component (update_data event)
						// and the component need to be rendered in full as in list mode
						if(self.node && node) {
							// DES
								// const parent = self.node.parentNode
								// if (!parent) {
								// 	console.warn('++++++++++++++ NO parent found for self.node:', self.node, ' render_level:', render_level);
								// 	console.warn('++++++++++++++ NO parent found for self:', self);
								// }else{
								// 	// replace
								// 	// parent.replaceChild(
								// 	// 	node, // new node
								// 	// 	self.node // old node
								// 	// )
								// 	self.node.replaceWith(node);
								// }
							if (self.node.nodeType !== Node.ELEMENT_NODE) {
								// console.log('self.node:', self.node);
								// console.log('self.node.nodeType:', self.node.nodeType);
								// console.log('node:', node);
								console.warn('Ignored node replacement for: non ELEMENT_NODE', self.node, 'nodeType:', self.node.nodeType);
							}else{
								// a windowed row (record_window) keeps its index, role and
								// draggable stamp across an event-driven full re-render.
								// Lazy: record_window is off the boot graph (page_load_budget),
								// and a windowed row means its module is already loaded
								if (self.node.hasAttribute('data-index')) {
									const {carry_row_attributes} = await import('../../section_record/js/record_window.js')
									carry_row_attributes(self.node, node)
								}
								self.node.replaceWith(node);
							}
						}
						// set pointers. Update instance node pointer
						self.node = node

					// return the new created node
					return node
			}//end switch(render_level)
		})()//end result_node fn

	// status update
		self.status = 'rendered'
		self._rendering_params = null

	// event publish
		event_manager.publish('render_'+self.id, result_node)

	// activate_tooltips
		if (self.mode === 'edit') {
			dd_request_idle_callback(
				() => {
					ui.activate_tooltips(result_node)
				}
			)
		}

	// debug
		if(typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) {
			// const total = (performance.now()-t0).toFixed(3)

			// if (self.model==='section') {
			// 	dd_console(`__Time [common.render] to render section: ${total} ms`,'DEBUG')
			// }else{
			// 	const msg = `__Time [common.render] to render model: ${self.model}, tipo: ${self.tipo}, section_tipo: ${self.section_tipo}, total (ms): `
			// 	if (total>100) {
			// 		console.log(msg, total, self);
			// 	}else{
			// 		// console.log(msg, total);
			// 	}
			// }
		}


	return result_node
}//end render



/**
* REFRESH
* Tear down and rebuild the instance in-place, then re-render.
* The standard pattern for data refresh after a save, external data change, or
* view-mode switch. Equivalent to destroy(dependencies only) → build → render.
*
* Execution order:
*  1. Validate status is 'rendered' (refuses to refresh a partially initialized instance).
*  2. Optionally destroy child instances and event subscriptions (destroy=true).
*  3. Optionally inject a pre-fetched API response (tmp_api_response) so build()
*     can reuse it instead of issuing a redundant network request.
*  4. Call build(build_autoload) — fetches fresh context+data when autoload=true.
*  5. Render at the requested render_level ('content' by default, to avoid full re-layout).
*  6. Refresh the paginator if one exists.
*  7. Optionally publish 'sync_data_<id_base_lang>' so sibling components sharing
*     the same base language binding (e.g. TM rows) are notified.
*
* The owner row lock (lock_rows) is acquired after the status check and before
* step 2: a pending editor node in a section / portal's rows refuses the
* refresh (returns false) with nothing destroyed or rebuilt.
*
* (!) Events subscribed inside build() may duplicate on repeated refresh() calls
* if the concrete build() implementation does not guard against re-subscription.
* Each override should use event tokens and unsubscribe before re-subscribing.
*
* @param {Object} [options={}] - Refresh options bag
* @param {boolean} [options.build_autoload=true] - Pass as autoload arg to build()
* @param {string} [options.render_level='content'] - 'full' or 'content' render depth
* @param {boolean} [options.destroy=true] - Destroy child instances before rebuilding
* @param {boolean} [options.refresh_id_base_lang=false] - Publish sync event for TM siblings
* @param {Object|null} [options.tmp_api_response=null] - Pre-fetched API response to inject
* @returns {Promise<boolean>} true when rebuild+render succeeded; false on status mismatch
*   or when the row lock was refused
*/
common.prototype.refresh = async function(options={}) {
	// const t0 = performance.now()

	const self = this

	// options
		const build_autoload		= options.build_autoload ?? true
		const render_level			= options.render_level ?? 'content' // string full|content
		const destroy				= options.destroy ?? true
		const refresh_id_base_lang	= options.refresh_id_base_lang ?? false
		const tmp_api_response		= options.tmp_api_response ?? null

	// loading css add
		// const nodes_lenght = self.node.length
		// for (let i = nodes_lenght - 1; i >= 0; i--) {
		// 	self.node[i].classList.add('loading')
		// }

	// destroy (dependencies only)
		if (self.status!=='rendered') {
			console.warn("/// destroyed fail (expected status 'rendered') with actual status:", self.model, self.status);
			return false
		}

	// owner row lock. Before the first mutation (destroy / build): a pending
	// editor node in this owner's rows refuses the refresh here, with nothing
	// touched (see lock_rows). Re-entrant: an operation that already holds the
	// lock (navigate, link…) passes straight through.
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await refresh_locked(self, {
				build_autoload,
				render_level,
				destroy,
				refresh_id_base_lang,
				tmp_api_response
			})
		} finally {
			release_rows()
		}
}//end refresh



/**
* REFRESH_LOCKED
* The body of refresh, run under the owner row lock.
* @param {Object} self - The instance being refreshed (status 'rendered')
* @param {Object} options - The resolved refresh options
* @returns {Promise<boolean>}
*/
const refresh_locked = async function(self, options) {

	const {
		build_autoload,
		render_level,
		destroy,
		refresh_id_base_lang,
		tmp_api_response
	} = options

		// Note: this action takes a insignificant amount of time (0 to 3 ms),
		// it is worth waiting until it is finished to make sure to destroy events safely
		if (destroy===true) {
			await self.destroy(
				false, // bool delete_self
				true, // bool delete_dependencies
				false // bool remove_dom
			)
		}

	// debug
		if(SHOW_DEBUG===true) {
			// console.group("Refresh "+self.model +" "+ (self.tipo ? self.tipo : '') );
			// console.log("+ Time to destroy:", self.model, performance.now()-t0);
			// var t1 = performance.now()
		}

	// tmp_api_response
	// use a injected api_response instead re-call to API when autoload is set to true
	// some cases the actions will get the datum of the component as save new data
	// in those cases inject the api_response into the component to re-use it.
		if(build_autoload && tmp_api_response){
			self.tmp_api_response = tmp_api_response
		}

	// build. Update the instance with new data
		//if (self.status==='destroyed') {
		await self.build( build_autoload ) // default value is true
		//}else{
		//	console.warn("/// build fail with status:", self.model, self.status);
		//	return false
		//}

	// tmp_api_response. Important!
	// delete the tmp_api_response to return to normal build (calling to API)
		if(self.tmp_api_response){
			delete self.tmp_api_response
		}

	// debug
		if(SHOW_DEBUG===true) {
			// console.log("+ Time to build [inside common.refresh]:", self.model, performance.now()-t1);
			// var t2 = performance.now()
		}

	// Render. Only render content_data, not the whole element wrapper
		let result
		if (self.status==='built') {
			await self.render({
				render_level : render_level // Note that default value is 'content'
			})
			if (self.paginator) {
				self.paginator.refresh()
			}
			result = true
		}else{
			console.warn(`[common.refresh] Ignored render '${self.model}' (expected status 'built') with status:`, self.status);
			result = false
		}

	// loading css remove class
		// for (let i = nodes_lenght - 1; i >= 0; i--) {
		// 	self.node[i].classList.remove('loading')
		// }

	// event sync_data_ . Used to update the DOM elements of the instance
	// refresh_id_base_lang. On true, force to refresh components with same 'id_base_lang'
	// @see render_tool_upload.upload_done
		if (refresh_id_base_lang===true) {
			const id_base_lang = self.id_base + '_' + self.lang
			event_manager.publish('sync_data_'+id_base_lang, {
				caller			: self,
				changed_data	: null
			})
		}

	// debug
		if(SHOW_DEBUG===true) {
			// console.log("+ Time to render:", self.model, performance.now()-t2);
			// console.log("+ Time to full refresh:", self.model, performance.now()-t0);
			// console.log("%c+ Time to full refresh:" +" "+ self.model + " " + (performance.now()-t0), "color:#d2f115");
			// console.groupEnd();
		}


	return result
}//end refresh_locked



/**
* LOCK_ROWS
* THE owner row lock (WC-2026-10-30-section-record-row-box): acquired by every
* row-set operation of a section / portal — refresh, both navigates, tag
* filter / reset, link, unlink, add, sort_data, sort_by_column — BEFORE its
* first mutation, and released in a `finally`. It guarantees that no editor
* value that lives only in its DOM node (typed, not yet committed) dies with
* the old rows when the operation replaces them.
*
* On the FIRST acquire of an owner (row_lock_depth 0 → 1):
*  1. `flush()` on every `owner.row_hovers` slot (the mosaic / tool hover
*     overlays: their nodes are judged against the live hover instance, never
*     against the rows);
*  2. `commit_uncommitted()` on every `owner.record_windows` slot (synthetic
*     change + blur, judged by the editor's commit_seq outcome);
*  3. any PENDING node (hover or row) → the user-facing refusal
*     (resolve_pending_rows): the lock's OWN confirm — never check_unsaved_data,
*     whose OK runs the page-wide reset_unsaved_data. Cancel → null (nothing
*     frozen, nothing mutated, focus back on the pending node). OK → scoped
*     discard of exactly those nodes / instances, then step 4 like the clean
*     path (OK never skips the freeze);
*  4. `freeze()` every window slot: the old content is `inert` from here to the
*     content swap, so no node can become uncommitted while the request is in
*     flight.
* A NESTED acquire (depth > 0: the refresh inside a navigate) only counts.
* `release()` (idempotent) decrements; at 0 it thaws every slot frozen by this
* lock that is still connected — a no-op after a successful swap (the old
* container is gone), the restore after a refused or failed operation. The
* frozen set belongs to the OWNER's lock (`owner.row_lock_frozen`), never to the
* first acquire's release: whichever holder releases LAST thaws it, so a nested
* holder that outlives the first one cannot leave the rows inert.
*
* An owner without windows or hovers (most components) gets a release that
* only keeps the depth count. `common.render` never refuses and is not part of
* the lock: a refused operation leaves status 'rendered', data, rqo, paginator
* and DOM exactly as they were.
*
* @param {Object} owner - The section / portal (any common instance)
* @returns {Promise<Function|null>} release function, or null when the user
*   refused (Cancel): the operation must then return false without mutating
*/
export const lock_rows = async function(owner) {

	if (!owner) {
		return () => {}
	}

	// a concurrent first acquire is still flushing: wait for its verdict
		while (owner.row_lock_acquiring) {
			await owner.row_lock_acquiring
		}

	// nested acquire: count only
		if (owner.row_lock_depth > 0) {
			owner.row_lock_depth++
			return make_row_lock_release(owner)
		}

	// first acquire
		let resolve_acquiring
		owner.row_lock_acquiring = new Promise(resolve => { resolve_acquiring = resolve })
		try {
			const windows	= Object.values(owner.record_windows || {}).filter(Boolean)
			const hovers	= Object.values(owner.row_hovers || {}).filter(Boolean)

			// 1. hover overlays first, 2. then the rows
			const pending = []
			for (const hover of hovers) {
				const flushed = await hover.flush()
				pending.push(...(flushed?.pending || []))
			}
			for (const record_window of windows) {
				const committed = record_window.commit_uncommitted()
				pending.push(...(committed?.pending || []))
			}

			// 3. refusal: own confirm; OK = scoped discard
			if (pending.length > 0) {
				const accepted = resolve_pending_rows(pending)
				if (!accepted) {
					return null
				}
			}

			// 4. freeze (clean path and after OK alike). The frozen set is the
			// lock's, read by whichever release brings the depth back to 0
			for (const record_window of windows) {
				record_window.freeze()
			}
			owner.row_lock_frozen	= windows
			owner.row_lock_depth	= 1

			return make_row_lock_release(owner)
		} finally {
			owner.row_lock_acquiring = null
			resolve_acquiring()
		}
}//end lock_rows



/**
* LOCK_ROWS (prototype)
* `owner.lock_rows()` spelling of the exported lock_rows, for classes that
* copy the common prototype methods.
* @returns {Promise<Function|null>}
*/
common.prototype.lock_rows = function() {

	return lock_rows(this)
}//end lock_rows



/**
* MAKE_ROW_LOCK_RELEASE
* The release function of one lock_rows acquire. Idempotent: a second call is
* a no-op, so a `finally` and an early release cannot decrement twice. The
* release that brings the depth to 0 — first acquire or nested, in ANY order —
* thaws the windows the first acquire froze (`owner.row_lock_frozen`).
* @param {Object} owner
* @returns {Function}
*/
const make_row_lock_release = function(owner) {

	let released = false

	return () => {
		if (released) {
			return
		}
		released = true
		owner.row_lock_depth = Math.max(0, (owner.row_lock_depth || 0) - 1)
		if (owner.row_lock_depth===0) {
			// the lock's frozen set, whoever releases last.
			// A no-op on a window whose container left the document (swapped)
			const frozen = owner.row_lock_frozen || []
			owner.row_lock_frozen = null
			for (const record_window of frozen) {
				record_window.thaw()
			}
		}
	}
}//end make_row_lock_release



/**
* RESOLVE_PENDING_ROWS
* The user-facing half of the pending-node rule: a node whose value lives only
* in the DOM (the editor ignored the synthetic change) is about to be removed
* by a row-set operation. The user decides, with the SAME label as
* check_unsaved_data but never through it (its OK wipes the whole page
* registry):
*  - Cancel → false; focus returns to the first pending node, nothing changes
*    (the nodes are still registered: the windows re-registered them).
*  - OK → scoped discard: each pending node leaves the uncommitted registry
*    (deregister_uncommitted_input) and each instance those nodes resolved to
*    leaves the unsaved registry (deregister_unsaved_instance). Everything else
*    registered — other portals, failed saves, orphans — stays.
* @param {Array<{node: HTMLElement, instance: Object|null, index: number}>} pending
* @returns {boolean} true when the operation may proceed
*/
export const resolve_pending_rows = function(pending) {

	if (!Array.isArray(pending) || pending.length===0) {
		return true
	}

	const confirm_msg = get_label.discard_changes || 'Discard unsaved changes?'
	if (!confirm(confirm_msg)) {
		const first = pending.find(item => item?.node && typeof item.node.focus==='function')
		if (first) {
			first.node.focus()
		}
		return false
	}

	// scoped discard: only these nodes and the instances they resolved to
	const instances = new Set()
	for (const item of pending) {
		if (item?.node) {
			deregister_uncommitted_input(item.node)
		}
		if (item?.instance) {
			instances.add(item.instance)
		}
	}
	for (const instance of instances) {
		deregister_unsaved_instance(instance)
	}

	return true
}//end resolve_pending_rows



/**
* LOG_PENDING_ROWS
* The one logged branch of the pending-node rule: an owner destroy (not
* refusable — callers ignore its result, dd-modal on_close runs after hide) or
* an unlocked door removes rows that still hold a pending node. Each pending
* component is reported (model, tipo, section_id); never silent.
* @param {Object} owner - The section / portal
* @param {Array<{node, instance, index}>} pending
* @param {string} where - The path that drops the nodes
* @returns {void}
*/
export const log_pending_rows = function(owner, pending, where) {

	if (!Array.isArray(pending) || pending.length===0) {
		return
	}

	for (const item of pending) {
		const instance = item?.instance || null
		console.error(`[${where}] a pending editor value is dropped with its row`, {
			owner_model	: owner?.model,
			owner_tipo	: owner?.tipo,
			index		: item?.index,
			model		: instance?.model,
			tipo		: instance?.tipo,
			section_id	: instance?.section_id
		});
	}
}//end log_pending_rows



/**
* DESTROY_ROW_WINDOWS
* Owner-destroy half of the row windows: called by the section / portal
* destroy override BEFORE common.prototype.destroy cascades into the rows.
*  1. `flush()` then `destroy()` on every `owner.row_hovers` slot (the hover
*     overlay commits / settles first; a dirty overlay instance is orphaned,
*     never destroyed);
*  2. `destroy()` on every `owner.record_windows` slot = flush (incl. the
*     uncommitted-node commit) → stop → generation++; failed instances are
*     orphaned by the window, the rest is destroyed by the owner's cascade;
*  3. both maps set to null. `owner.record_window_generation` is NEVER reset.
* Every returned pending node is logged (log_pending_rows): the user-facing
* guard is upstream (check_unsaved_data before page-level destroys, the row
* lock before every row-set operation).
* @param {Object} owner - The section / portal
* @returns {Promise<void>}
*/
export const destroy_row_windows = async function(owner) {

	if (!owner) {
		return
	}

	const hovers	= owner.row_hovers ? Object.values(owner.row_hovers).filter(Boolean) : []
	const windows	= owner.record_windows ? Object.values(owner.record_windows).filter(Boolean) : []
	owner.row_hovers		= null
	owner.record_windows	= null

	for (const hover of hovers) {
		try {
			const flushed = await hover.flush()
			log_pending_rows(owner, flushed?.pending, 'destroy_row_windows (hover flush)')
			const destroyed = await hover.destroy()
			log_pending_rows(owner, destroyed?.pending, 'destroy_row_windows (hover)')
		} catch (error) {
			console.error('[destroy_row_windows] hover teardown failed:', error);
		}
	}

	for (const record_window of windows) {
		try {
			const destroyed = await record_window.destroy()
			log_pending_rows(owner, destroyed?.pending, 'destroy_row_windows')
		} catch (error) {
			console.error('[destroy_row_windows] window destroy failed:', error);
		}
	}
}//end destroy_row_windows



/**
* DESTROY_UNWINDOWED_DEPENDENCIES
* The dependencies destroy of a section / portal `build(true)`: every instance
* in `owner.ar_instances` EXCEPT the rows a live record window holds.
* Those rows belong to their window: the next content render's door retires it,
* and retire adopts the ones the new window takes from the instance cache
* (`refresh({destroy:false})`) and flushes before destroying the rest. Destroying
* them here would bypass that flush (a dirty row instance would die unsettled)
* and break the adoption. A `refresh({destroy:true})` has already destroyed them
* before its build, so it is unaffected.
* The live hover overlays go FIRST, through their own controller: a hover
* instance sits in `owner.ar_instances` but in no window, so the cascade below
* would destroy it directly and a still-dirty overlay editor (a failed save)
* would leave the unsaved registry unorphaned. `hover.destroy()` flushes, then
* orphans what stayed dirty and destroys the rest (row_hover.js teardown);
* its pending nodes are logged (the user-facing guard was the row lock).
* @param {Object} owner - The section / portal
* @returns {Promise<void>}
*/
export const destroy_unwindowed_dependencies = async function(owner) {

	// 1. hover overlays: torn down by their controller (orphans failed), never by the cascade
	const hover_instances = new Set()
	for (const hover of Object.values(owner.row_hovers || {})) {
		if (!hover) {
			continue
		}
		if (hover.instance) {
			hover_instances.add(hover.instance)
		}
		try {
			const destroyed = await hover.destroy()
			log_pending_rows(owner, destroyed?.pending, 'destroy_unwindowed_dependencies (hover)')
		} catch (error) {
			console.error('[destroy_unwindowed_dependencies] hover teardown failed:', error);
		}
	}
	if (hover_instances.size > 0 && Array.isArray(owner.ar_instances)) {
		owner.ar_instances = owner.ar_instances.filter(el => !hover_instances.has(el))
	}

	const held = new Set()
	for (const record_window of Object.values(owner.record_windows || {})) {
		if (!record_window) {
			continue
		}
		for (let i = 0; i < record_window.size; i++) {
			const row = record_window.record_at(i)
			if (row) {
				held.add(row)
			}
		}
	}

	if (held.size===0 || !Array.isArray(owner.ar_instances)) {
		await owner.destroy(
			false, // bool delete_self
			true, // bool delete_dependencies
			false // bool remove_dom
		)
		return
	}

	// windowed: NOT owner.destroy — the section / portal override releases the
	// windows themselves (destroy_row_windows) on a dependencies destroy, and the
	// rows they hold would then outlive them unretired. Only the other
	// dependencies go, the same way do_delete_dependencies takes them.
	const others = owner.ar_instances.filter(el => !held.has(el))
	owner.ar_instances = owner.ar_instances.filter(el => held.has(el))
	await Promise.all(others.map(async (current_instance) => {
		if (!current_instance || current_instance.destroyable===false) {
			return
		}
		if (typeof current_instance.destroy!=='function') {
			console.error('Ignored instance without \'destroy\' method:', owner, current_instance)
			return
		}
		try {
			await current_instance.destroy(
				true, // delete_self
				true, // delete_dependencies
				false // remove_dom
			)
		} catch (err) {
			console.error('Error destroying instance:', err, current_instance)
		}
	}))
}//end destroy_unwindowed_dependencies



/**
* PLACE_LIST_AFTER
* The `.list_after` slot (WC-2026-10-30-section-record-row-box): the ONE
* non-row sibling of a row view — references, list footer, no_records, error,
* print notice. It is never inside `content_data` (row invariant) nor inside a
* `role=table` list_body. A view's get_content_data hands it as the expando
* `content_data.list_after` (node or null).
*
* Used by the view's FULL render (after content_data / list_body are in the
* wrapper) and by common.render's 'content' swap: replace, remove or insert the
* new node right after `wrapper.list_body || content_data`, then point
* `wrapper.list_after` at it. A strict no-op when neither the wrapper nor the
* content_data carries a pointer (most components).
* @param {HTMLElement} wrapper - The instance wrapper (self.node)
* @param {HTMLElement} content_data - The (new) content_data node
* @returns {void}
*/
export const place_list_after = function(wrapper, content_data) {

	if (!wrapper || !content_data) {
		return
	}

	const old_node	= wrapper.list_after || null
	const next_node	= content_data.list_after || null
	if (!old_node && !next_node) {
		return
	}

	if (!next_node) {
		old_node.remove()
	}else if (old_node && old_node.parentNode) {
		if (old_node!==next_node) {
			old_node.replaceWith(next_node)
		}
	}else{
		const anchor = wrapper.list_body || content_data
		anchor.after(next_node)
	}

	wrapper.list_after = next_node
}//end place_list_after



/**
* DESTROY
* Tear down an instance and optionally its child instances and DOM node.
* The three boolean flags let callers control exactly what gets cleaned up:
*
*   delete_dependencies — iterates `self.ar_instances` and destroys each child
*     recursively via do_delete_dependencies(). Called first so children are gone
*     before self-cleanup removes the event subscriptions they may depend on.
*
*   delete_self — unsubscribes all event tokens, destroys paginator/services/
*     inspector/filter sub-objects, removes self from the global instances map,
*     removes self from caller.ar_instances, and nullifies heavy properties
*     (context, data, datum, etc.) to release memory. Sets status → 'destroyed'.
*
*   remove_dom — removes `self.node` from the DOM tree and sets `self.node = null`.
*     Only meaningful when the caller owns the DOM lifecycle (e.g. a parent section
*     clearing its children before re-rendering).
*
* A double-destroy guard (`status === 'destroyed'`) makes this safe to call
* redundantly — it returns an empty result object without throwing.
*
* Always publishes 'destroy_<id>' after cleanup so external listeners can react
* (e.g. a parent waiting for child teardown before re-rendering itself).
*
* @param {boolean} [delete_self=true] - Destroy own events, sub-objects, and instance registration
* @param {boolean} [delete_dependencies=false] - Recursively destroy child instances in ar_instances
* @param {boolean} [remove_dom=false] - Remove `self.node` from the DOM and null it
* @returns {Promise<Object>} result — keys `delete_dependencies` and `delete_self` set to
*   the return value of each internal helper when invoked; absent when skipped
*/
common.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self		= this
	const result	= {}

	// double destroy protection
		if (self.status === 'destroyed') {
			return result
		}

	// delete_dependencies. Destroy all associated instances
		if(delete_dependencies===true) {
			result.delete_dependencies = await do_delete_dependencies(self)
		}

	// delete_self. Destroy self instance
		if(delete_self===true) {
			result.delete_self = await do_delete_self(self)
		}

	// remove_dom. Remove element main DOM node (optional)
		if (remove_dom===true) {
			if(self.node && (self.node.nodeType===Node.ELEMENT_NODE || self.node.nodeType===Node.TEXT_NODE)) {
				// remove DOM node if exists (wrapper)
				try {
					self.node.remove()
				} catch (error) {
					console.error('Error removing node of type: ' + self.node.nodeType, error)
				}
			}
			// reset instance node property value (always reset to release memory reference)
			self.node = null
		}

	if (delete_self===true) {
		// status update
		self.status = 'destroyed'

		// reset instance node property value (always reset to release memory reference)
		self.node = null
	}

	// event publish
		event_manager.publish('destroy_'+self.id)


	return result
}//end destroy



/**
* DO_DELETE_SELF
* Internal helper called by destroy() when delete_self is true.
* Performs ordered teardown of all resources owned by the instance:
*
*  1. Unsubscribes every token in `self.events_tokens` (reverse-iterates to
*     safely splice while iterating).
*  2. Destroys `self.paginator` if present.
*  3. Destroys all entries in `self.services` (in parallel via Promise.all).
*  4. Destroys `self.inspector` if present.
*  5. Destroys `self.filter` if present.
*  6. Removes the instance from the global instances map via delete_instance(self.id).
*  7. Retires any unsaved-data registration via deregister_unsaved_instance(self),
*     so a destroyed dirty instance cannot keep the derived window.unsaved_data
*     guard armed forever.
*  8. Removes self from `self.caller.ar_instances` to prevent stale references.
*  9. Nullifies heavy properties (context, data, datum, ar_instances, events_tokens,
*     caller, request_config) to release memory held by closures.
*
* @param {Object} self - The Dédalo instance being destroyed
* @returns {Promise<boolean>} true when cleanup is complete
*/
const do_delete_self = async function (self) {

	// delete events. Delete the instance registered events
		const events_tokens	= self.events_tokens || []
		// remove all subscriptions
		const events_tokens_length = events_tokens.length
		for (let i = events_tokens_length - 1; i >= 0; i--) {
			const unsubscribed = event_manager.unsubscribe(events_tokens[i])
			if (unsubscribed) {
				events_tokens.splice(i, 1)
			}
		}

	// destroy paginator
		if(self.paginator){
			await self.paginator.destroy(
				true, // delete_self
				true, // delete_dependencies
				false // remove_dom
			)
			delete self.paginator
		}

	// destroy services
		if (self.services && self.services.length > 0) {
			const services_to_destroy = [...self.services]
			self.services.length = 0 // Clear immediately

			await Promise.all(services_to_destroy.map(async (current_service, i) => {
				if (SHOW_DEBUG === true) {
					console.log('removing services:', i, services_to_destroy.length, current_service)
				}
				if (typeof current_service?.destroy === 'function') {
					await current_service.destroy(
						true, // delete_self
						true, // delete_dependencies
						false // remove_dom
					)
				}
			}))
		}

	// destroy inspector
		if (self.inspector) {
			await self.inspector.destroy(
				true, // delete_self
				true, // delete_dependencies
				false // remove_dom
			)
			delete self.inspector
		}

	// destroy filter
		if (self.filter) {
			await self.filter.destroy(
				true, // delete_self
				true, // delete_dependencies
				false // remove_dom
			)
			delete self.filter
		}

	// Delete instance from global instances register.
	// self.id is equivalent to the intances_map key
	// delete_instance returns false if the instance was not found because is already removed.
	const result = delete_instance( self.id )

	// unsaved-data registry. Retire any unsaved registration this instance
	// holds: window.unsaved_data is DERIVED from the events.js registry, and a
	// destroyed dirty instance left registered would keep the navigation guard
	// armed forever with no component left to save or revert. No-op when the
	// instance never registered (Set semantics).
		deregister_unsaved_instance(self)

	// delete caller instance reference (ar_instances)
		if (self.caller?.ar_instances) {
			const ar_instances_length = self.caller.ar_instances.length
			for (let i = ar_instances_length - 1; i >= 0; i--) {
				const item = self.caller.ar_instances[i]
				if (item.id===self.id) {
					self.caller.ar_instances.splice(i, 1)
					break;
				}
			}
		}

	// memory optimization. Nullify large property references
		self.context		= null
		self.data			= null
		self.datum			= null
		self.ar_instances	= []
		self.events_tokens	= []
		self.caller			= null
		self.request_config	= null


	return true
}//end do_delete_self



/**
* DO_DELETE_DEPENDENCIES
* Destroy all child instances registered in `self.ar_instances`.
* Called by destroy() when delete_dependencies is true.
*
* Snapshots the ar_instances array and clears it immediately (before awaiting
* anything) to prevent race conditions where a concurrent destroy could
* encounter the same list. Each child is then destroyed in parallel via
* Promise.all; instances with `destroyable === false` are skipped.
*
* Errors thrown by individual child destroy() calls are caught and logged
* without aborting the remaining teardown.
*
* @param {Object} self - The Dédalo instance whose children should be destroyed.
*   Must have an `ar_instances` array property.
* @returns {Promise<boolean>} Always resolves to true (array was cleared at the start;
*   individual failures are logged but do not propagate)
*/
const do_delete_dependencies = async function (self) {

	// Guard against missing array
	if (!Array.isArray(self.ar_instances)) {
		console.error("Undefined or invalid self.ar_instances:", self);
		return false;
	}

	// remove instances from self ar_instances
	// Performance optimization: Snapshot and clear array immediately
	const instances_to_destroy = [...self.ar_instances]
	self.ar_instances.length	= 0 // Clear immediately to prevent race conditions

	if (instances_to_destroy.length > 0) {
		await Promise.all(instances_to_destroy.map(async (current_instance) => {

			// Skip non‑existing or non‑destroyable instances
			if (!current_instance || current_instance.destroyable === false) {
				return
			}

			if (typeof current_instance.destroy === 'function') {
				try {
					const current_instance_id = current_instance.id
					await current_instance.destroy(
						true, // delete_self
						true, // delete_dependencies
						false // remove_dom
					)

					if (SHOW_DEBUG === true) {
						// console.log('instance_to_destroy:', current_instance_id)
					}

				} catch (err) {
					console.error("Error destroying instance:", err, current_instance)
				}
			} else {
				console.error("Ignored instance without 'destroy' method:", self, current_instance)
			}
		}))
	}

	// All instances removed? Returns true since we cleared the array at the start
	const result = true


	return result
}//end do_delete_dependencies



/**
* CREATE_SOURCE
* Build the `source` descriptor object that the server API uses to identify
* which instance is making a request and what data it needs.
*
* The source is a plain object with `typo: 'source'` as its type marker.
* It is attached to every RQO (request query object) sent to the API.
*
* Optional property groups appended when present on `self`:
*   - `source_add` (Object) — arbitrary key/value pairs merged into source by
*     components that need to pass extra parameters (e.g. component_relation_model
*     sends `ar_target_section_tipo`).
*   - `matrix_id` — included when the instance is operating on a specific matrix
*     row (time machine mode).
*   - `data_source` — included when set to e.g. 'tm' (time machine read).
*   - `is_temporal` — included when the instance is a temporary write (e.g. tool_propagate).
*   - `caller_dataframe` — included when model is 'component_dataframe'; provides
*     the pairing information needed by the server to resolve the dataframe context.
*   - `properties` — forwarded when set on the instance so the server can apply
*     instance-specific configuration during processing.
*
* Example output:
* ```json
* {
*   "typo": "source",
*   "type": "component",
*   "action": "read",
*   "model": "component_text_area",
*   "tipo": "rsc17",
*   "section_tipo": "rs167",
*   "section_id": "5",
*   "mode": "edit",
*   "view": "default",
*   "lang": "lg-eng"
* }
* ```
*
* @param {Object} self - The Dédalo instance (component, section, portal, etc.)
* @param {string} action - API action name, e.g. 'read', 'get_data', 'save'
* @returns {Object} source descriptor ready to embed in an RQO
*/
export const create_source = function (self, action) {

	// ddo source
		const source = { // source object
			typo			: 'source',
			type			: self.type,
			action			: action,
			model			: self.model,
			tipo			: self.tipo,
			section_tipo	: self.section_tipo || self.tipo,
			section_id		: self.section_id,
			mode			: self.mode,
			view			: get_view(self), // self.view || self.context?.view || null, // 'default',
			lang			: self.lang
		}

	// add the properties defined by the component instance to be parsed
	// used by component_relation_model to add ar_target_section_tipo into the source to build the read API call.
		if(self.source_add){
			// get all properties defined by component instance
			const add_source_keys = Object.keys(self.source_add)
			const source_keys_len = add_source_keys.length
			for (let i = 0; i < source_keys_len; i++) {
				// assign instance properties to source object.
				source[add_source_keys[i]] = self.source_add[add_source_keys[i]]
			}
		}


	// matrix_id optional (used in time machine mode)
		if (true===self.hasOwnProperty('matrix_id') && self.matrix_id) {
			source.matrix_id = self.matrix_id
		}

	// data_source optional (used in time machine mode). data_source='tm'
		// if (self.context && true===self.context.hasOwnProperty('data_source') && self.context.data_source) {
		if (self.data_source) {
			source.data_source = self.data_source
		}

	// is temporal bool optional (used in tools like 'tool_propagate_component_data')
		if (self.is_temporal) {
			source.is_temporal = self.is_temporal
		}

	// temporal_scope optional (WC-079): names the owning tool so the server can
	// key this instance's scratch row. Only sent alongside is_temporal, and only
	// by service_tmp_section — its absence is what keeps every other temporal
	// producer on the no-persistence path.
		if (self.temporal_scope) {
			source.temporal_scope = self.temporal_scope
		}

	// caller_dataframe
		if(self.model==='component_dataframe'){
			source.caller_dataframe = self.caller_dataframe
				? self.caller_dataframe
				: {
					main_component_tipo	: self.caller?.tipo || null,
					section_tipo		: self.section_tipo,
					section_id			: self.section_id,
					id_key				: self.data.id_key
				}
		}


	// properties
		if (self.properties) {
			source.properties = self.properties
		}


	return source
}//end create_source



/**
* CREATE_CALLERS
* The caller chain of a NESTED component instance — `rqo.source.callers`, the
* component instances it sits under, from the OUTERMOST down to its direct
* parent (server: src/core/relations/caller_chain.ts). Sent on the component's
* own get_data (paging, build_rqo_show) and search (autocomplete,
* build_rqo_search) so the server resolves it UNDER its caller, exactly as the
* cell was resolved on page 1: the children its caller injected are expanded
* and inherited (a read-only column a restricted profile saw on page 1 stays on
* page 2), and the search read floor admits them (a field only the caller's map
* names is searchable from inside the cell). The server VERIFIES every link and
* answers a refused chain as a top-level read — the chain is a claim, never a
* grant.
*
* Shape:
*   tch197's rsc1400 cell on tch1/1 (edit):
*     [{tipo:'tch197', section_tipo:'tch1', mode:'edit'}]
*   the same cell in a tch1 LIST (the column map is the section's):
*     [{tipo:'tch1', section_tipo:'tch1', mode:'list'},
*      {tipo:'tch197', section_tipo:'tch1'}]
*
* The walk is by MODEL, never by depth (client_caller_chain_tripwire): rows
* (section_record) and groupers are passed through, components collected, a
* section ends it; any other ancestor (a tool, a service, an area) ends it too —
* what stands above it is not the cell's data chain. Cycle-safe (tool_common's
* new-window path sets caller.caller = self).
*
* A component whose children its SECTION's map injects (a section list line
* `{tipo: rsc86, parent: <portal>}`, a nested line a section EDIT
* request_config declares — DECL → DREL → REL4) is rooted at the SECTION in
* either mode (section_injects_children), the top-level one included:
*   DREL, top-level in a test3 edit whose map declares DREL's children:
*     [{tipo:'test3', section_tipo:'test3', mode:'edit'}]
*
* @param {Object} self - The component instance the rqo is built for
* @returns {Array|null} the chain, or null for a top-level component its
*   section does not inject into, or a chain the server could not accept (root
*   mode not edit/list, deeper than CALLERS_MAX_DEPTH)
*/
const CALLERS_MAX_DEPTH = 12 // = server MAX_DDO_DEPTH (relations/element_node.ts)
const CALLERS_ROOT_MODES = ['edit', 'list']
export const create_callers = function (self) {

	if (!self || typeof self.model!=='string' || !self.model.startsWith('component_')) {
		return null
	}
	// dataframes are paired to their main component, not nested under it
	if (self.model==='component_dataframe') {
		return null
	}

	// the component ancestors, outermost first (get_component_ancestors)
		const {components, section, dataframe} = get_component_ancestors(self)
		if (dataframe===true) {
			return null
		}
		if (components.length===0) {
			// top level: a chain only when the section's map injects this
			// component's children (its own config otherwise, nothing to resolve
			// under)
			const root = section_root_link(section, self)
			return root ? [root] : null
		}

	// links
		const callers = components.map(el => ({
			tipo			: el.tipo,
			section_tipo	: el.section_tipo
		}))

	// root. A LIST column's map is its section's: the section is the root. So is
	// it when the section's map injects the outermost's children (an EDIT
	// request_config declaring a nested line, DECL → DREL → REL4 —
	// section_root_link). Otherwise the outermost component is, with its own
	// render mode.
	// The root is where the occurrence was READ, never the cell instance's
	// current render mode: a list column whose ddo declares mode 'edit', or one
	// switched to edit inline (component_common change_mode keeps the list read's
	// context), still sits in the LIST read's map. Server side the section root
	// is derived in the READ's mode (caller_chain.ts sectionRootNode) and child
	// lines match by tipo / section only (childLineOf).
		const outermost		= components[0]
		const section_root	= section_root_link(section, outermost)
		if (section && section.mode==='list'
			&& section.tipo && section.tipo===(section.section_tipo || section.tipo)) {
			callers.unshift({
				tipo			: section.tipo,
				section_tipo	: section.tipo,
				mode			: 'list'
			})
		}else if (section_root) {
			callers.unshift(section_root)
		}else{
			if (!CALLERS_ROOT_MODES.includes(outermost.mode)) {
				return null
			}
			callers[0].mode = outermost.mode
		}

		if (callers.length > CALLERS_MAX_DEPTH) {
			return null
		}


	return callers
}//end create_callers



/**
* CREATE_SEARCH_CALLERS
* The caller chain a component names on its PICKING reads — the autocomplete
* search (build_rqo_search) and the tree picker's reads (component_portal
* picker_caller → area_thesaurus / ts_object). Exactly create_callers, plus a
* TOP-LEVEL component's own section as root: `[{tipo:S, section_tipo:S, mode}]`.
*
* WHY. A user may pick a value into a component they can WRITE from a target
* section they hold no grant on (owner decision (h)/(i), nested-ddo_map plan
* round 4). The server admits that read ONLY through a VERIFIED chain ending at
* the component (src/core/security/writer_chain_scope.ts): a top-level
* component has no component caller, so its chain is its section — the read
* that rendered it. Its paging read (build_rqo_show) keeps create_callers: no
* chain there for a top-level component, as before.
*
*   rsc91 (autocomplete → toponymy) top-level in an rsc197 edit:
*     [{tipo:'rsc197', section_tipo:'rsc197', mode:'edit'}]
*
* @param {Object} self - The component instance
* @returns {Array|null} the chain, or null (dataframe, no section, virtual
*   section mismatch, a root mode the server does not accept)
*/
export const create_search_callers = function (self) {

	const callers = create_callers(self)
	if (callers) {
		return callers
	}
	if (!self || typeof self.model!=='string' || !self.model.startsWith('component_')
		|| self.model==='component_dataframe') {
		return null
	}
	const {components, section, dataframe} = get_component_ancestors(self)
	if (dataframe===true || components.length>0) {
		return null
	}
	if (!section || !section.tipo || section.tipo!==(section.section_tipo || section.tipo)) {
		return null
	}
	if (!CALLERS_ROOT_MODES.includes(section.mode)) {
		return null
	}


	return [{
		tipo			: section.tipo,
		section_tipo	: section.tipo,
		mode			: section.mode
	}]
}//end create_search_callers



/**
* SECTION_INJECTS_CHILDREN
* Whether a SECTION instance's own map (its main dedalo request_config item's
* show ddo_map: the list columns, or the edit request_config it declares)
* declares children for the component `tipo` — a line with `parent: tipo`. Then
* that component's context was INJECTED by the section (server: relations/
* element_node.ts rootNodeFor — the read's column map is the caller of every
* top-level element), and its own reads must say so (component_portal
* sends_own_show, create_callers).
*
*   test3 list map [test80, {tipo:test52, parent:'test80'}] → test80: true
*
* @param {Object|null} section - The section instance (get_component_ancestors)
* @param {string} tipo - The component tipo
* @returns {boolean}
*/
export const section_injects_children = function(section, tipo) {

	if (!section || typeof tipo!=='string') {
		return false
	}
	const request_config_object = section.request_config_object
		|| section.context?.request_config?.find(el => el.api_engine==='dedalo' && el.type==='main')
	const ddo_map = request_config_object?.show?.ddo_map


	return Array.isArray(ddo_map) && ddo_map.some(el => el && el.parent===tipo)
}//end section_injects_children



/**
* SECTION_ROOT_LINK
* Module-private. The SECTION root link `{tipo:S, section_tipo:S, mode}` for a
* component whose children the section's map injects (section_injects_children),
* in the section's own render mode (edit / list) — else null. A virtual-section
* mismatch (tipo ≠ section_tipo) has no root the server can derive.
* The component's own render mode is NOT compared: the root is the read the
* section ran (its mode), whatever mode the cell instance renders in now (a
* list column with ddo mode 'edit', an inline change_mode to edit).
* @param {Object|null} section
* @param {Object} component - The outermost component instance (or the top-level one)
* @returns {Object|null}
*/
const section_root_link = function(section, component) {

	if (!section || !section.tipo || section.tipo!==(section.section_tipo || section.tipo)) {
		return null
	}
	if (!CALLERS_ROOT_MODES.includes(section.mode)) {
		return null
	}
	if (!section_injects_children(section, component.tipo)) {
		return null
	}


	return {
		tipo			: section.tipo,
		section_tipo	: section.tipo,
		mode			: section.mode
	}
}//end section_root_link



/**
* GET_COMPONENT_ANCESTORS
* THE one walk up an instance's `.caller` chain to the COMPONENT instances it
* sits under (nested-ddo_map plan W5). Two consumers read it, and they must
* agree on what "the chain" is:
*   - create_callers — `rqo.source.callers`, the chain the server verifies;
*   - get_caller_chain_tipos — the per-occurrence `caller_chain` a cell's
*     context / data item is matched by (owner decision (b)).
*
* By MODEL, never by depth (client_caller_chain_tripwire): rows
* (section_record) and groupers are passed through, components collected, a
* section ends it (and is returned as the root); any other ancestor (a tool, a
* service, an area) ends it too — what stands above it is not the cell's data
* chain. Cycle-safe (tool_common's new-window path sets caller.caller = self).
*
* Example — tch197's rsc1400 cell, a rsc86 instance inside it:
*   rsc86 → section_record → rsc1400 → section_record → tch197 → section_group → tch1
*   get_component_ancestors(rsc86) → {components:[tch197, rsc1400], section:tch1, dataframe:false}
*
* @param {Object} instance - Any instance (component, section_record …); the walk starts at its caller
* @returns {{components: Array<Object>, section: Object|null, dataframe: boolean}}
*   components outermost first (the instance itself is never included); section
*   the section that ended the walk, if any; dataframe true when a
*   component_dataframe stands on the path
*/
const CALLERS_PASS_THROUGH = ['section_record', 'section_group', 'section_group_div', 'section_tab', 'tab']
export const get_component_ancestors = function(instance) {

	const components	= []
	const visited		= new Set([instance])
	let section			= null
	let dataframe		= false
	let current			= instance ? instance.caller : null
	while (current && !visited.has(current)) {
		visited.add(current)
		const model = current.model
		if (model==='section') {
			section = current
			break
		}
		if (typeof model==='string' && model.startsWith('component_')) {
			if (model==='component_dataframe') {
				dataframe = true
			}
			components.push(current)
		}else if (!CALLERS_PASS_THROUGH.includes(model) && current.type!=='grouper') {
			break // a tool / service / area: not the cell's data chain
		}
		current = current.caller
	}
	components.reverse() // outermost first


	return {components, section, dataframe}
}//end get_component_ancestors



/**
* GET_CALLER_CHAIN_TIPOS
* The component tipos an instance sits under, outermost first — the client
* side of the server's per-occurrence `caller_chain` (src/core/section/
* node_contexts.ts: the ancestor TIPO path from the read's top level down to
* the element's parent, joined by '>'). For a CELL built by a section_record,
* pass the section_record: the cell's chain is everything above the row.
*
*   tch197 → row → [rsc1400 cell]   get_caller_chain_tipos(row) → ['tch197']
*   a top-level column of a section list                         → []
*
* The server's chain is relative to the read that carried it (a page-2
* get_data of rsc1400 roots its response at rsc1400: rsc1400 itself is '',
* its cells 'rsc1400'). Each received item is therefore tagged with the path of
* its read's root (root_caller_chains, at intake — build_autoload,
* update_datum) and matched EXACTLY on root + chain (select_by_caller_chain);
* a suffix match survives only for an item that arrived untagged.
*
* @param {Object} instance
* @returns {Array<string>}
*/
export const get_caller_chain_tipos = function(instance) {

	return get_component_ancestors(instance).components.map(el => el.tipo)
}//end get_caller_chain_tipos



/**
* ROOT_CALLER_CHAINS
* Tag every `caller_chain`-stamped item of a READ's response with the path of
* that read's root (owner decision (b) — W5 review 2026-11-03). The server
* stamps chains relative to the read's own top level
* (relations/element_registry.ts ancestorTipos stops at the read's root):
*   - a SECTION read is rooted at the section: chains are already the cell
*     paths the client computes (get_caller_chain_tipos) — root ''.
*   - a COMPONENT's own read (page 2, refresh, save echo) is rooted at the
*     component: its own entry is '', its cells '<tipo>' — root = the
*     component's own ancestor path (get_caller_chain_tipos(reader)).
* So an item's ABSOLUTE chain = root + chain, compared EXACTLY with an
* instance's path (select_by_caller_chain): no suffix guess, which picks the
* wrong occurrence when a tipo repeats in the ancestry (a self-portal test80
* under test80 — path [test80, test80] ends both 'test80' and
* 'test80>test80').
*
* The tag is `caller_root` (a '>'-joined path), NON-enumerable: it never goes
* back on the wire (JSON) nor survives a structuredClone — such a copy is
* matched by the legacy suffix rule. Idempotent: an item already tagged keeps
* its root (a shared datum item is tagged by the read that brought it).
*
* @param {Object|null} datum - {context:[], data:[]} of one response
* @param {Object} reader - The instance that issued the read (section or component)
* @returns {Object|null} the same datum
*/
export const root_caller_chains = function(datum, reader) {

	if (!datum || typeof datum!=='object' || !reader) {
		return datum
	}

	// lazily: most responses carry no stamped item at all
	let root = null
	const root_of_reader = () => {
		if (root===null) {
			root = (typeof reader.model==='string' && reader.model.startsWith('component_'))
				? get_caller_chain_tipos(reader).join('>')
				: '' // a section (or any other container) is its read's top level
		}
		return root
	}

	for (const list of [datum.context, datum.data]) {
		if (!Array.isArray(list)) {
			continue
		}
		for (const item of list) {
			if (!item || typeof item!=='object' || typeof item.caller_chain!=='string') {
				continue
			}
			if (typeof item.caller_root==='string') {
				continue // idempotent
			}
			Object.defineProperty(item, 'caller_root', {
				value			: root_of_reader(),
				enumerable		: false,
				writable		: true,
				configurable	: true
			})
		}
	}


	return datum
}//end root_caller_chains



/**
* ABSOLUTE_CALLER_CHAIN
* Module-private. The tipo path of a stamped item from the PAGE's top level
* (root_caller_chains `caller_root` + its own `caller_chain`), or null when the
* item arrived untagged (its read's root is unknown).
* @param {Object} item
* @returns {Array<string>|null}
*/
const absolute_caller_chain = function(item) {
	if (typeof item.caller_root!=='string') {
		return null
	}
	return [
		...caller_chain_segments(item.caller_root),
		...caller_chain_segments(item.caller_chain)
	]
}//end absolute_caller_chain



/**
* SAME_CHAIN
* Module-private. Two tipo lists are equal.
* @param {Array<string>} a
* @param {Array<string>} b
* @returns {boolean}
*/
const same_chain = function(a, b) {
	return a.length===b.length && a.every((tipo, i) => tipo===b[i])
}//end same_chain



/**
* CALLER_CHAIN_SEGMENTS
* A wire `caller_chain` ('tch197>rsc1400', '' = top level) as its tipo list.
* @param {string} caller_chain
* @returns {Array<string>}
*/
const caller_chain_segments = function(caller_chain) {
	return caller_chain==='' ? [] : caller_chain.split('>')
}//end caller_chain_segments



/**
* IS_CHAIN_SUFFIX
* Whether `suffix` (tipo list) ends `path` (tipo list).
* @param {Array<string>} suffix
* @param {Array<string>} path
* @returns {boolean}
*/
const is_chain_suffix = function(suffix, path) {
	if (suffix.length > path.length) {
		return false
	}
	const offset = path.length - suffix.length
	for (let i = 0; i < suffix.length; i++) {
		if (suffix[i]!==path[offset + i]) {
			return false
		}
	}
	return true
}//end is_chain_suffix



/**
* SELECT_BY_CALLER_CHAIN
* Pick, among the context entries (or data items) sharing one identity key
* (tipo, section_tipo, mode …), the one whose `caller_chain` belongs to the
* instance path `chain_tipos` (owner decision (b), 2026-11-03 — each occurrence
* resolves its own; server: src/core/section/node_contexts.ts).
*
* The server stamps `caller_chain` ONLY when one key has two or more distinct
* effective configs in a response; otherwise no candidate carries it and the
* first one wins — exactly the previous first-wins `.find()`.
*
* Matching: a candidate TAGGED with its read's root (root_caller_chains) matches
* when root + chain EQUALS `chain_tipos` exactly — the response may be rooted
* below the page's top (a nested portal's page 2), the tag puts its chains back
* on the page's path. An UNTAGGED stamped candidate (a cloned item, a
* hand-built datum) falls back to the legacy rule: its chain must be a SUFFIX
* of `chain_tipos`, the LONGEST matching suffix wins. With no stamped match: the
* first UNSTAMPED candidate; else the ONE untagged stamped chain the path
* itself ends (a response chain longer than the client can see — a tool
* between the cell and its section); else NOTHING (undefined, warned). Never an arbitrary stamped candidate: that is another
* parent's config, the very thing decision (b) exists to prevent. The server
* gives EVERY chain of a split key its own entry (node_contexts.ts
* NodeContextSet.absorb), so a cell of a real read always finds its own.
*
*   candidates: [{caller_chain:'tch197', …[rsc86, rsc85]}, {caller_chain:'P2', …[rsc85]}]
*   chain_tipos ['P2']               → the P2 entry
*   chain_tipos ['tch1x', 'tch197']  → the tch197 entry
*
* @param {Array<Object>} candidates - entries sharing one identity key, in datum order
* @param {Array<string>|Function} chain_tipos - the instance path, or a function
*   returning it (called only when a choice is really needed)
* @returns {Object|undefined} the selected candidate (undefined for no candidates)
*/
export const select_by_caller_chain = function(candidates, chain_tipos) {

	if (!candidates || candidates.length===0) {
		return undefined
	}
	if (candidates.length===1) {
		return candidates[0]
	}
	const stamped = candidates.filter(el => typeof el.caller_chain==='string')
	if (stamped.length===0) {
		return candidates[0]
	}

	const path = typeof chain_tipos==='function'
		? (chain_tipos() || [])
		: (chain_tipos || [])

	// tagged: exact, on the page's path
	const exact = stamped.find(el => {
		const absolute = absolute_caller_chain(el)
		return absolute!==null && same_chain(absolute, path)
	})
	if (exact) {
		return exact
	}

	// untagged (legacy): the longest stamped suffix of the path
	const untagged = stamped.filter(el => typeof el.caller_root!=='string')
	let best		= null
	let best_length	= -1
	for (const candidate of untagged) {
		const segments = caller_chain_segments(candidate.caller_chain)
		if (segments.length > best_length && is_chain_suffix(segments, path)) {
			best		= candidate
			best_length	= segments.length
		}
	}
	if (best) {
		return best
	}

	const unstamped = candidates.find(el => typeof el.caller_chain!=='string')
	if (unstamped) {
		return unstamped
	}

	// the path is a suffix of exactly ONE untagged stamped chain (the client
	// sees less of the ancestry than the response was rooted at)
	const extending = untagged.filter(el => is_chain_suffix(path, caller_chain_segments(el.caller_chain)))
	if (extending.length===1) {
		return extending[0]
	}

	console.warn('[select_by_caller_chain] no occurrence matches the instance path:', path, stamped.map(el => el.caller_chain));


	return undefined
}//end select_by_caller_chain



/**
* CALLER_CHAINS_COMPATIBLE
* Whether two items of one identity key may be the SAME occurrence when one
* response is merged into a shared datum (component_common.update_datum).
* Unstamped on either side → compatible (the pre-(b) identity). Both stamped
* AND both tagged with their read's root (root_caller_chains `caller_root`) →
* compatible only when the absolute chains are EQUAL ('tch197>rsc1400' from
* the section read and 'rsc1400' rooted at 'tch197' from that portal's own page
* 2 are one occurrence; a repeated tipo — 'test80' vs 'test80>test80' — is
* two). Otherwise (an untagged side) the legacy rule: compatible when one chain
* is a suffix of the other — never two different parents ('tch197' vs 'P2').
*
* @param {string|undefined} chain_a
* @param {string|undefined} chain_b
* @param {string} [root_a] - chain_a's item `caller_root`, when tagged
* @param {string} [root_b] - chain_b's item `caller_root`, when tagged
* @returns {boolean}
*/
export const caller_chains_compatible = function(chain_a, chain_b, root_a, root_b) {

	if (typeof chain_a!=='string' || typeof chain_b!=='string') {
		return true
	}
	if (typeof root_a==='string' && typeof root_b==='string') {
		return same_chain(
			[...caller_chain_segments(root_a), ...caller_chain_segments(chain_a)],
			[...caller_chain_segments(root_b), ...caller_chain_segments(chain_b)]
		)
	}
	const a = caller_chain_segments(chain_a)
	const b = caller_chain_segments(chain_b)


	return a.length <= b.length
		? is_chain_suffix(a, b)
		: is_chain_suffix(b, a)
}//end caller_chains_compatible



/**
* SAME_OCCURRENCE_ON_MERGE
* Whether an INCOMING item of a response may be merged INTO an EXISTING datum
* item of the same identity key (component_common.update_datum — owner
* decision (b)). Directional, unlike caller_chains_compatible:
*   - incoming UNSTAMPED → the pre-(b) identity: it matches any existing item
*     (stamped or not) and updates it in place.
*   - incoming STAMPED → it matches only a STAMPED existing item with a
*     compatible chain. An UNSTAMPED existing entry is never its twin: the
*     server stamps a key only when it splits WITHIN one response
*     (node_contexts.ts), so a key can arrive unstamped in the section read and
*     split only in a later read (a nested portal's page 2, a refresh after a
*     link is added). Matching that unstamped entry would swallow EVERY stamped
*     occurrence ('P' and 'P>Q' alike) and lose the split. The stamped items
*     are appended beside it instead; select_by_caller_chain prefers an exact
*     stamped match, so each cell takes its own occurrence and the stale
*     unstamped entry serves only paths no stamped one matches.
*
* @param {Object} existing - item already in the shared datum
* @param {Object} incoming - item of the response being merged
* @returns {boolean}
*/
export const same_occurrence_on_merge = function(existing, incoming) {

	if (typeof incoming.caller_chain!=='string') {
		return true
	}
	if (typeof existing.caller_chain!=='string') {
		return false
	}


	return caller_chains_compatible(existing.caller_chain, incoming.caller_chain, existing.caller_root, incoming.caller_root)
}//end same_occurrence_on_merge



/**
* REBUILD_COMPONENT_IN_LANG
* Switch an ALREADY-BUILT component to another data language and really reload
* its data in that language.
*
* Why this is needed: component build() MEMOIZES — on status 'built' it returns
* true immediately without touching the API
* (component_common.prototype.build). So the obvious sequence
*
*     component.lang = other_lang
*     await component.build(true)   // ← no-op, data stays in the OLD lang
*
* silently leaves the instance carrying the previous language's data, and the
* component renders EMPTY whenever the new language holds different (or no)
* text. Every caller that changes `lang` after build must reset the build state
* first, and the tools that open a transcription in its ORIGINAL language
* (tool_transcription, tool_indexation, tool_lang — all reading
* `context.options.related_component_lang`) were hand-rolling that with
* different levels of correctness: only tool_transcription had the reset, so the
* other two opened blank on any record whose original language differed from the
* menu's.
*
* A standalone function, NOT a prototype method: the client's component models
* CHERRY-PICK the methods they expose (`component_text_area.prototype.build =
* component_common.prototype.build`, …) instead of inheriting a prototype chain,
* so a method added to component_common.prototype is simply absent from the
* model instances the tools actually hold.
*
* `context.lang` is synchronised too: do_build assigns `self.context` only when
* it is ABSENT, so a rebuilt component would otherwise keep a context claiming
* a language whose data is no longer the one loaded.
*
* @param {Object} component - A built component instance
* @param {string|null} lang - Target data lang, e.g. 'lg-vlca'. Falsy = no-op,
*   so callers can pass an optional `related_component_lang` straight in.
* @returns {Promise<boolean>} true when a reload happened, false when there was
*   nothing to do (no lang given, or the component is already in that lang)
*/
export const rebuild_component_in_lang = async function(component, lang) {

	if (!component || !lang || component.lang===lang) {
		return false
	}

	component.lang = lang
	if (component.context) {
		component.context.lang = lang
	}

	// reset the memoized build state so build(true) really re-fetches
	component.status			= 'initialized'
	component._build_waiter		= null

	await component.build(true)

	return true
}//end rebuild_component_in_lang



/**
* GET_VIEW
* Resolve the active view string for an instance with a context fallback.
* Returns `self.view` when set; otherwise falls back to `self.context.view`;
* returns null when neither is available.
* Used internally by create_source() to populate the source.view field.
*
* @param {Object} self - The Dédalo instance
* @returns {string|null} The active view name, e.g. 'default', 'list', or null
*/
const get_view = function(self) {

	const view = self.view || self.context?.view || null

	return view
}//end get_view



/**
* GET_RQO_TEST
* Construct a minimal, copy-pasteable RQO for developer inspection.
* The resulting object can be pasted directly into the Area Development
* Playground to replay the component's API call in isolation.
*
* Exposed on every instance as a lazy getter (`self.rqo_test`) — the getter
* is installed by set_context_vars() via Object.defineProperty so the value
* is always computed fresh from the current instance state.
*
* @param {Object} self - The Dédalo instance to describe
* @returns {Object} rqo — minimal request query object {action:'read', source:{...}}
*/
const get_rqo_test = function(self) {

	const source = create_source(self, 'get_data')

	const rqo = {
		action	: 'read',
		source	: source
	}

	return rqo
}//end get_rqo_test



/**
* GET_COLUMNS_MAP
* Resolve a flat ordered array of column descriptors from the active request_config,
* taking the full ddo_map hierarchy (portals inside portals, portals inside sections)
* into account.
*
* The returned `columns_map` drives grid headers and column-to-component binding in
* list/search views. Each column descriptor shape:
* ```json
* {
*   "id":           "dd345",
*   "tipo":         "dd345",
*   "section_tipo": "oh1",
*   "label":        "Name",
*   "model":        "component_input_text",
*   "width":        null,
*   "sortable":     false
* }
* ```
*
* Column grouping strategy (controlled by `view`):
*   'line'   — all child components of a portal share a single column keyed on the
*               portal's tipo. Useful for compact inline display.
*   'mosaic' — each component becomes its own column; each ddo gains `in_mosaic`
*               and `hover` flags used by the mosaic renderer.
*   default  — each component becomes its own column (deduplication guards prevent
*               the same tipo appearing twice).
*
* When `value_with_parents` is set on any ddo, an extra synthetic `ddinfo` column is
* inserted after the matching component column (or appended at the end) so that parent
* context can be displayed alongside the value.
*
* `ddo_map_sequence` controls the fallback priority order for picking the ddo_map from
* request_config (e.g. ['search','show'] in search mode, ['show'] otherwise).
* For autocomplete, the sequence ['choose','search','show'] is passed explicitly.
*
* @param {Object} options - Configuration object
* @param {Object} options.context - Instance context object (from API response)
* @param {Array|null} [options.datum_context=null] - Section-level context array used
*   to look up `sortable` and `path` flags for each column
* @param {Array<string>|null} [options.ddo_map_sequence=null] - Priority list of
*   request_config keys to search for a ddo_map; defaults to ['show'] or ['search','show']
* @returns {Array<Object>} columns_map — ordered array of column descriptor objects
* @see section_record.get_ar_columns_instances_list for a caller-side overview
*/
export const get_columns_map = function(options) {

	// options
		const context			= options.context
		const datum_context		= options.datum_context
		const ddo_map_sequence	= options.ddo_map_sequence
			? options.ddo_map_sequence // service_autocomplete gives this value as [choose,search,show]
			: context.mode==='search'
				? ['search','show'] // normally portals in search mode
				: ['show'] // default value

	const columns_map = []

	// tipo
		const tipo				= context.tipo
	// request_config. get the request_config with all ddo to use in the columns
		const request_config	= context.request_config || []
	// source_columns_map.  Get the columns_maps defined in the properties and assigned in context in the server or by the client.
		// the columns_maps become as structure to complete with the request_config
		// by default the columns are for every component that has direct link to the component(portal) or section
		// if the portal has more component in deep, it can define as columns in the properties,
		// but by default, the portal will be only one column (with all components joined in the cell).
		const source_columns_map = context.columns_map || []
	// view
		const view			= context.view
		const children_view	= context.children_view || null

	// storage of all ddo_map in flat array, without hierarchy, to find the components easily.
		const full_ddo_map = []
	// set itself as ddo
		full_ddo_map.push(context)

	// ddo_map_sequence. calculate length once
		const ddo_map_sequence_length = ddo_map_sequence.length

	// request_config could be multiple (Dédalo, Zenon, etc), all columns need to be compatible to create
	// the final grid.
		const request_config_length	= request_config.length
		for (let i = 0; i < request_config_length; i++) {

			const request_config_item = request_config[i]

			// ddo_map. Get the ddo map to be used.
			// @see section_record.get_ar_columns_instances_list for a better overview

				// Reference legacy sequence < 30-05-2024
				// const ddo_map = (context.mode !== 'search')
				// 	? request_config_item.show.ddo_map
				// 	: request_config_item.choose && request_config_item.choose.ddo_map && request_config_item.choose.ddo_map.length > 0
				// 		? request_config_item.choose.ddo_map
				// 		: request_config_item.search && request_config_item.search.ddo_map && request_config_item.search.ddo_map.length > 0
				// 			? request_config_item.search.ddo_map
				// 			: request_config_item.show.ddo_map

				const ddo_map = (()=>{
					for (let k = 0; k < ddo_map_sequence_length; k++) {
						const el = ddo_map_sequence[k]
						if (request_config_item[el] && request_config_item[el].ddo_map && request_config_item[el].ddo_map.length > 0) {
							return request_config_item[el].ddo_map
						}
					}
					return []
				})();

			// get the direct components of the caller (component or section)
			const ar_first_level_ddo		= ddo_map.filter(item => item.parent === tipo)
			const ar_first_level_ddo_len	= ar_first_level_ddo.length

			// store the current component in the full ddo map
			full_ddo_map.push(...ddo_map)
			for (let j = 0; j < ar_first_level_ddo_len; j++) {

				const dd_object = ar_first_level_ddo[j]
				// set the view if it is defined in ontology set it else get the parent view
				dd_object.view 	= dd_object.view || children_view || view || null // 'default'

				// if the ddo has a column_id and columns_maps are defined in the properties,
				// get the column as it has defined.
				if (dd_object.column_id && source_columns_map.length > 0){

					// column_exists. If the column has stored by previous ddo, don't touch the array,
					// it's necessary to preserve the order of the columns_map
						const column_exists = columns_map.find(el => el.id === dd_object.column_id)
						if(column_exists) continue

					// check if the ddo has defined the column_id in the columns_map,
					// if not, add new column with the ddo information.
						const found	= source_columns_map.find(el => el.id===dd_object.column_id)
						const column = (found)
							? found
							: {
								id		: dd_object.tipo,
								label	: dd_object.tipo,
								model	: dd_object.model,
								tipo	: dd_object.tipo,
							  }

					// column width set
						column.width = dd_object.width || column.width || null

					dd_object.column_id = column.id
					columns_map.push(column)

				}else{
					// if the ddo don't has column_id and the column_map is not defined in properties,
					// create a new column with the ddo information or join all components in one column
					switch(true){
						// component_portal will join the components that doesn't has columns defined.
						case view && view==='line': {

							// find if the general column was created, if not create new one with the tipo
							// of the component_portal to include all components.
							const found	= columns_map.find(el => el.id===tipo)

							// if the column exist add general column to ddo information,
							// else create the general column and add the id to the component.
							if(found){

								dd_object.column_id = found.id

							}else{
								//create the general column with the tipo of the component_portal
								const column = {
									id		: tipo,
									label	: tipo,
									tipo	: tipo,
									model	: dd_object.model
								}

								columns_map.push(column)
								// set the column_id of the component with the column id
								dd_object.column_id = column.id
							}
							break;
						}
						// in the mosaic case add the in_mosaic: true or false to create the mosaic and
						// the alternative table with all ddo
						case view && view.indexOf('mosaic') !== -1 :
							dd_object.in_mosaic = dd_object.in_mosaic
								? true
								: false
							dd_object.hover 	= dd_object.hover
								? true
								: false

							columns_map.push(
								{
									id			: dd_object.tipo,
									label		: dd_object.tipo,
									in_mosaic	: dd_object.in_mosaic,
									hover		: dd_object.hover,
									tipo		: dd_object.tipo,
									model		: dd_object.model
								}
							)
							dd_object.column_id	= dd_object.tipo
							break;
						// by default every component will create the own column if the column is not defined,
						// this behavior is used by sections.
						default:
							// deduplicate. check if the column already exists
							if (!columns_map.find(el => el.id === dd_object.tipo)) {

								columns_map.push(
									{
										id		: dd_object.tipo,
										label	: dd_object.tipo,
										model	: dd_object.model,
										tipo	: dd_object.tipo
									}
								)
								dd_object.column_id = dd_object.tipo
							}
							break;
					}//end switch
				}//end if (dd_object.column_id && source_columns_map.length > 0)
			}//end for (let j = 0; j < ar_first_level_ddo_len; j++)
		}//end for (let i = 0; i < request_config_length; i++)

	// parse_columns
		// Resolve the label of the all columns recursively, columns could has sub-columns (in the columns_map properties)
		// here will be using the full_ddo_map to find the specific ddo
		function parse_columns(columns_map){

			const columns_map_len = columns_map.length
			for (let i = columns_map_len - 1; i >= 0; i--) {

				const column_item = columns_map[i]

				// all columns has a label property that point to the ddo tipo to use, finding the ddo it is possible obtain the label to use in the column.
				// when the column was built the columns will has tipo, therefore the ddo_object is possible to get from tipo in the column
					const ddo_object = full_ddo_map.find(el => el.tipo===column_item.label || el.tipo===column_item.tipo)

				// add tipo always
					column_item.tipo = ddo_object
						? ddo_object.tipo
						: column_item.label

				// add section_tipo always
					column_item.section_tipo = ddo_object
						? Array.isArray(ddo_object.section_tipo)
							? ddo_object.section_tipo[0]
							: ddo_object.section_tipo
						: null

				// sortable
					const found = datum_context
						? datum_context.find(el => el.tipo===column_item.tipo)
						: false
					column_item.sortable = found
						? found.sortable
						: false

				// sort_by_column (v7 per-ddo model, WC-048): the column ddo opts in
				// to the persistent header-click reorder. Read from the ddo_object
				// (request_config passthrough), NOT the top-level component property.
					column_item.sort_by_column = ddo_object
						? ddo_object.sort_by_column === true
						: false

				// model
					column_item.model = found && found.model
						? found.model
						: column_item.model || null

				// width
					column_item.width = column_item.width
						? column_item.width
						: ddo_object && ddo_object.width
							? ddo_object.width
							: null

				// path
					if (column_item.sortable===true) {
						if (!found.path) {
							console.warn('Error. Ignored column_item sortable without path', column_item, ddo_object );
							column_item.sortable = false
						}else{
							column_item.path = found.path
						}
					}

				// check if the ddo has label, if not empty label will set.
					column_item.label = (ddo_object && ddo_object.label)
						? ddo_object.label
						: column_item.label

				// if the columns has sub-columns, begin again.
					if(column_item.columns_map) {
						parse_columns(column_item.columns_map)
					}
			}
		}
		// exec parse_columns of result columns_map
		parse_columns(columns_map)


	// column ddinfo
		// Create one `ddinfo` column for each distinct column having ddo with value_with_parents=true,
		// placed right after the column of the ddo that generates the parents info.
		// Rows only fill the columns of their own section; anchoring the ddinfo to each ddo column
		// preserves the order `term | parents` for every searched section
		// (e.g. `tch555` choose list searching hierarchy sections [hierarchy25] and tchi1 [tchi15] at the same time).
		// Ddos sharing the same column (columns_map defined in properties, like component_dataframe cases)
		// will share one ddinfo column, placed after it.
		// Every ddinfo column stores the tipos of its anchor ddos in `from_ddo_tipos`;
		// the renderer uses it to match the `from_ddo_tipo` of the data items created by the server.
		// If the anchor column is not found, a fallback ddinfo column is added at the last position.
		// See behavior and the ontology definition of `tch555`
		const ar_value_with_parents = full_ddo_map.filter(el => el.value_with_parents === true)
		if (ar_value_with_parents.length > 0) {

			// group the ddos by its anchor column position
			const ar_ddinfo_groups = [] // as [{index, from_ddo_tipos}]
			const ar_value_with_parents_length = ar_value_with_parents.length
			for (let i = 0; i < ar_value_with_parents_length; i++) {
				const current_ddo = ar_value_with_parents[i]
				const index = columns_map.findIndex(el =>
					el.tipo === current_ddo.tipo ||
					(current_ddo.column_id && el.id === current_ddo.column_id)
				)
				const group = ar_ddinfo_groups.find(el => el.index === index)
				if (group) {
					group.from_ddo_tipos.push(current_ddo.tipo)
				}else{
					ar_ddinfo_groups.push({
						index			: index,
						from_ddo_tipos	: [current_ddo.tipo]
					})
				}
			}

			// insert the ddinfo columns from the last to the first position to preserve the calculated indexes
			ar_ddinfo_groups.sort((a, b) => b.index - a.index)
			const ar_ddinfo_groups_length = ar_ddinfo_groups.length
			for (let i = 0; i < ar_ddinfo_groups_length; i++) {
				const current_group = ar_ddinfo_groups[i]
				const ddinfo_column = {
					id				: 'ddinfo',
					label			: 'Info',
					from_ddo_tipos	: current_group.from_ddo_tipos
				}
				if(current_group.index>=0){
					columns_map.splice(current_group.index+1, 0, ddinfo_column)
				}else{
					columns_map.push(ddinfo_column)
				}
			}
		}

	// debug
		if(SHOW_DEBUG===true) {
			// console.log("full_ddo_map---------:"+self.tipo,full_ddo_map);
			// console.log("columns_map:",columns_map); // throw 'stop'
		}

	return columns_map
}//end get_columns_map



/**
* GET_AR_INVERTED_PATHS
* Walk a flat ddo_map (produced by collapsing nested request_config trees) and
* return one "inverted path" array per leaf node. Each path array is ordered
* from leaf → root so that path[0] is the value-bearing component and the last
* element is the topmost ancestor.
*
* Only leaf nodes (ddo entries that have no children pointing to them as parent)
* contribute a path. Intermediate nodes (portals, relation components) appear only
* as path ancestors.
*
* Example — for a structure "interview → people under study → name":
*   full_ddo_map entries: interview_ddo, people_study_ddo, name_ddo
*   Result: [[name_ddo, people_study_ddo, interview_ddo]]
*
* This inverted format makes it convenient for build_rqo_search() to walk from
* the leaf outward, building the nested SQO path in server-expected order after
* a final reverse pass.
*
* component_dataframe entries encountered anywhere in a path cause the entire path
* to be skipped (they carry their own independent SQO).
*
* @param {Array<Object>} full_ddo_map - Flat array of ddo descriptors. Each entry
*   must have at minimum `tipo` (string) and `parent` (string) properties.
* @returns {Array<Array<Object>>} ar_inverted_paths — one sub-array per leaf,
*   ordered [leaf, parent, grandparent, …]
*/
export const get_ar_inverted_paths = function(full_ddo_map) {

	// get the parents for the column, creating the inverse path
	// (from the last component to the main parent, the column will be with the data of the first item of the column)
	function get_parents(ddo_map, current_ddo) {
		const ar_parents = []
		const parent = ddo_map.find(item => item.tipo === current_ddo.parent)
		if (parent) {
			ar_parents.push(parent)
			ar_parents.push(...get_parents(ddo_map, parent))
		}
		return ar_parents
	}

	// every ddo will be checked if it is a component_portal or if is the last component in the chain
	// set the valid_ddo array with only the valid ddo that will be used.
		const ar_inverted_paths = []
		const ddo_length = full_ddo_map.length
		for (let i = 0; i < ddo_length; i++) {
			const current_ddo = full_ddo_map[i]
			// check if the current ddo has children associated, it's necessary identify the last ddo in the path chain, the last ddo create the column
			// all parents has the link and data to get the data of the last ddo.
			// interview -> people to study -> name
			// «name» will be the column, «interview» and «people under study» has the locator to get the data.
			const current_ar_valid_ddo = full_ddo_map.filter(item => item.parent === current_ddo.tipo)
			if(current_ar_valid_ddo.length !== 0) continue
			const column = []

			// get the path with inverse order
			// people to study -> interview
			const parents = get_parents(full_ddo_map, current_ddo)

			// join all with the inverse format
			// name -> people to study -> interview
			column.push(current_ddo, ...parents)
			ar_inverted_paths.push(column)
		}

	return ar_inverted_paths
}//end get_ar_inverted_paths



/**
* BUILD_RQO_SHOW
* Assemble the RQO (request query object) for a 'show' (data retrieval) API call.
* The RQO is the primary data structure sent by the client to the Dédalo API; this
* builder produces the canonical 'read' variant used by components, sections, and
* portals when fetching record data.
*
* Key resolution steps:
*  1. Clone `_request_config_object` to avoid mutating the cached config.
*  2. Build a fresh `source` from the current instance state via create_source().
*  3. Resolve `sqo` from `request_config_object.sqo` → `show.sqo_config` → `{}`.
*  4. Normalize `sqo.section_tipo` to an array of bare tipo strings (the server emits
*     ddo objects; bare strings are kept as a defensive fallback for old contexts).
*  5. Apply pagination defaults for `limit` and `offset` from sqo_config when the
*     sqo does not already have them.
*  6. Resolve `filter_by_locators` from sqo or sqo_config; if absent, auto-generate
*     a single-record locator from `self.section_tipo` + `self.section_id`.
*  7. Optionally attach `rqo.show` when `add_show=true` (used by portals that need
*     the full show config for ddo_map resolution on the server).
*
* @param {Object} _request_config_object - The request config (cloned internally)
* @param {string} action - API action name to embed in the source, e.g. 'get_data'
* @param {boolean} [add_show=false] - When true, attach `request_config_object.show`
*   to the returned rqo as `rqo.show`
* @returns {Promise<Object>} rqo — ready to pass to data_manager.request()
*/
common.prototype.build_rqo_show = async function(_request_config_object, action, add_show=false){

	const self = this

	// clone request_config_object
		const request_config_object = clone(_request_config_object)

	// source. build new one with source of the instance caller (self)
		const source = create_source(self, action)

	// callers. A nested component names its caller chain (create_callers)
		const callers = create_callers(self)
		if (callers) {
			source.callers = callers
		}

	// sqo_config
		const sqo_config = request_config_object && request_config_object.show && request_config_object.show.sqo_config
			? request_config_object.show.sqo_config
			: false

	// sqo with fallback to sqo_config
		const sqo = request_config_object && request_config_object.sqo
			? request_config_object.sqo
			: sqo_config
				? sqo_config
				: {}

	// without sqo info case
		if (!sqo) {
			// build a minimal rqo without sqo
			const rqo = {
				id		: self.id,
				action	: 'read',
				source	: source
			}
			return rqo
		}

	// ar_sections. Get ar_sections from sqo and map to string from object
	// (the server emits ddo objects {tipo,...} from every construction path;
	// the bare-string branch is kept as a defensive fallback for old contexts)
		const ar_sections = (sqo && sqo.section_tipo)
			? sqo.section_tipo.map(el => el.tipo ? el.tipo : el)
			: sqo_config && sqo_config.section_tipo
				? sqo_config.section_tipo.map(el => el.tipo ? el.tipo : el)
				: [self.section_tipo]

		sqo.section_tipo = ar_sections

	// pagination
	// Get the limit, offset, full count, and filter by locators.
	// When these options comes with the sqo it passed to the final sqo, if not, it get the show.sqo_config parameters
	// and finally if the request_config_object don't has sqo or sqo_config, set the default parameter to each.
		// sqo.limit
		if (sqo.limit===undefined) {
			sqo.limit = (sqo_config && sqo_config.limit!==undefined)
				? sqo_config.limit
				// : self.mode==='edit' ? 1 : null; // force to generate default limit from server (!)
				: null
		}
		// sqo.offset
		if (sqo.offset===undefined) {
			sqo.offset = (sqo_config && sqo_config.offset!==undefined)
				? sqo_config.offset
				: null;
		}

	// filter_by_locators
		const filter_by_locators = (sqo.filter_by_locators)
			? sqo.filter_by_locators
			: (sqo_config && sqo_config.filter_by_locators)
				? sqo_config.filter_by_locators
				: null
		if (filter_by_locators) {
			sqo.filter_by_locators = filter_by_locators
		}else if(self.section_id!==null && self.section_id!==undefined && self.section_tipo){
			// note the explicit null/undefined test: section_id 0 is a legitimate id
			sqo.filter_by_locators = [{
				section_tipo	:self.section_tipo,
				section_id		: self.section_id
			}]
		}else{
			// NO PIN — say it explicitly. An omitted key is FILLED from the
			// server's session SQO (concepts/sqo.ts mergeSessionSqo), so a plain
			// list would inherit the single-record pin a previous edit read stored
			// there and render that one record. `[]` means "no pins" (zero hits use
			// the section_id:-1 sentinel, never an empty array).
			sqo.filter_by_locators = []
		}

	// sqo clean
		delete sqo.generated_time

	// build the rqo
		const rqo = {
			id		: self.id,
			action	: 'read',
			source	: source,
			sqo		: sqo
		}

		if (add_show===true) {
			if (request_config_object.show) {
				rqo.show = request_config_object.show
			}
			// console.warn("added rqo.show:", self.tipo, self.mode, rqo.show);
		}


	return rqo
}//end build_rqo_show



/**
* BUILD_RQO_SEARCH
* Build the RQO for a search/autocomplete API call. Used by portals and
* autocomplete services to query candidate records based on a user-typed string.
*
* Unlike build_rqo_show(), this method assembles an open-ended search SQO with a
* `filter_free` block containing one path clause per leaf component in the ddo_map.
* Each clause gets an empty `q` that the caller fills in before dispatching.
*
* Key resolution steps:
*  1. Determine the boolean `operator` ('$or' by default, mirrors server default).
*  2. Resolve `sqo_config` from search → show fallback.
*  3. Resolve `ar_sections` from sqo → sqo_config → [self.section_tipo].
*  4. Resolve `limit`/`offset` from choose.sqo_config → sqo_config → choose_limit_default (25).
*     The choose.sqo_config branch is kept in sync with the server-side chain in
*     request_config_v6 parse_choose_config.
*  5. Build `filter_free` by walking search_paths (server-emitted, when present),
*     else search.ddo_map (or show.ddo_map as fallback)
*     through get_ar_inverted_paths(), reversing each path to server order, and
*     adding one `{q:'', path:[...]}` entry per leaf per operator group.
*     component_dataframe paths are skipped (they have their own independent sqo).
*  6. Resolve `ddo_map` for the show section of the rqo from choose → search.
*  7. Attach `sqo_options` containing filter_free, fixed_filter, filter_by_list,
*     and operator so the server can complete the SQO on its side.
*
* @param {Object} request_config_object - Active request config for this instance
* @param {string} action - API action name, e.g. 'get_data'
* @returns {Promise<Object>} rqo — search request query object ready for data_manager
*/
common.prototype.build_rqo_search = async function(request_config_object, action){

	const self = this

	// build new one with source of the instance caller (self)
		const source	= create_source(self, action);

	// callers. The component names its caller chain (create_search_callers —
	// a top-level one names its section): the search read floor then admits
	// the fields its caller injected, and a WRITER component may search a
	// target section the user holds no grant on (scoped, server-verified)
		const callers = create_search_callers(self)
		if (callers) {
			source.callers = callers
		}

	// get the operator to use into the filter free
	// '$or' default mirrors the server default in request_config_utils
	// build_sqo_config_default / resolve_show_sqo_config — keep both in sync
		const operator	= request_config_object.search && request_config_object.search.sqo_config && request_config_object.search.sqo_config.operator
			? request_config_object.search.sqo_config.operator
			: '$or'

	// sqo. Set the sqo_config into a checked variable, get the sqo_config for search or show
		const sqo_config = request_config_object.search && request_config_object.search.sqo_config
			? request_config_object.search.sqo_config
			: request_config_object.show && request_config_object.show.sqo_config
				? request_config_object.show.sqo_config
				: {}

	// get the ar_sections
		const ar_sections = request_config_object.sqo && request_config_object.sqo.section_tipo
			? request_config_object.sqo.section_tipo.map(el => el.tipo ? el.tipo : el)
			: ( sqo_config.section_tipo)
					? sqo_config.section_tipo.map(el => el.tipo ? el.tipo : el)
					: [self.section_tipo]

	// limit and offset
	// check if limit and offset exist in choose, if not get from search.sqo_config, if not, get from show.sqo_config else fixed value
	// NOTE: the server now resolves choose.sqo_config.limit with the same chain
	// (request_config_v6 parse_choose_config); this fallback remains for configs
	// without a choose section and for old cached contexts — keep both in sync
		const choose_limit_default = 25
		const limit	= request_config_object.choose && request_config_object.choose.sqo_config && (request_config_object.choose.sqo_config.limit || request_config_object.choose.sqo_config.limit==0)
			? request_config_object.choose.sqo_config.limit
			: ((sqo_config.limit || sqo_config.limit==0)
				? sqo_config.limit
				: choose_limit_default)
		const offset = request_config_object.choose && request_config_object.choose.sqo_config && request_config_object.choose.sqo_config.offset
			? request_config_object.choose.sqo_config.offset
			: (sqo_config.offset)
				? sqo_config.offset
				: 0

	// sqo. new sqo_search
		const sqo = {
			mode					: self.mode,
			section_tipo			: ar_sections,
			filter					: {[operator]:[]},
			offset					: offset,
			limit					: limit,
			full_count				: false,
			allow_sub_select_by_id	: true
		}

	// children_recursive
		if(request_config_object.sqo.children_recursive){
			sqo.children_recursive = request_config_object.sqo.children_recursive
		}


	// FILTER_FREE
	// the filter will be used to set the q with all paths to use to search.
		const filter_free			= {}
			  filter_free[operator] = []

		// create the paths for use into filter_free
		// get the ddo_map to use for the paths in search or show or create new one with the caller
			const search_ddo_map = request_config_object.search && request_config_object.search.ddo_map
				? request_config_object.search.ddo_map
				: request_config_object.show && request_config_object.show.ddo_map
					? request_config_object.show.ddo_map
					: [{
						section_tipo	: self.section_tipo,
						component_tipo	: self.tipo,
						model			: self.model,
						parent			: 'self',
						mode			: 'list'
					}]

			// search_paths — server-emitted filter paths (relation columns spelled
			// through what they display: Modelo › Término; search_display_paths.ts).
			// Used for the filter_free paths ONLY: the result columns below keep
			// choose → search → show.
			const paths_ddo_map = Array.isArray(request_config_object.search_paths) && request_config_object.search_paths.length > 0
				? request_config_object.search_paths
				: search_ddo_map

			if (paths_ddo_map) {
				// get the sub elements with the ddo_map, the method is recursive,
				// it get only the items that don't has relations and is possible get values (component_input_text, component_text_area, compomnent_select, etc )
				const ar_paths = get_ar_inverted_paths(paths_ddo_map)
				// change the order of the paths to correct order for sqo and set all ddo to 'list' mode
				const paths_length = ar_paths.length
				paths: for (let i = 0; i < paths_length; i++) {
					const current_path = ar_paths[i]
					const current_path_length = current_path.length
					// reverse path and set the list
					const new_path = []
					ddo: for (let j = current_path_length - 1; j >= 0; j--) {
						// Dataframe nodes are outside the portal sqo (it has his own sqo) and need to be excluded
						if(current_path[j].model==='component_dataframe'){continue paths}
						// create a copy of the current ddo, it ensure that the original path is not touched
						const current_ddo = clone(current_path[j])
						current_ddo.mode = 'list' // enable lang fallback value
						if(Array.isArray(current_ddo.section_tipo)){
							current_ddo.section_tipo = current_ddo.section_tipo[0]
						}
						current_ddo.component_tipo	= current_ddo.tipo
						new_path.push(current_ddo)
					}
					//add the path to the filter_free with the operator
					filter_free[operator].push({
						q		: '',
						path	: new_path
					})
				}
			}


	// fixed_filter
		const fixed_filter	= request_config_object.sqo && request_config_object.sqo.fixed_filter
			? request_config_object.sqo.fixed_filter
			: false

	// fixed_filter
		if(request_config_object.sqo.fixed_children_filter){
			sqo.fixed_children_filter = request_config_object.sqo.fixed_children_filter
		}

	// filter_by_list if exists
		const filter_by_list = request_config_object.sqo && request_config_object.sqo.filter_by_list
			? request_config_object.sqo.filter_by_list
			: false

	// value_with_parents
		// const value_with_parents = sqo_config.value_with_parents
		// 	? sqo_config.value_with_parents
		// 	: false

	// fields_separator
		const fields_separator = request_config_object.choose && request_config_object.choose.fields_separator
				? request_config_object.choose.fields_separator
				: request_config_object.show && request_config_object.show.fields_separator
					? request_config_object.show.fields_separator
					: ', '


	// optional configuration to use when the search will be built
		const sqo_options = {
			filter_free		: filter_free,
			fixed_filter	: fixed_filter,
			filter_by_list	: filter_by_list,
			operator		: operator
		}

	// DDO_MAP
	// get the ddo_map to show the components, if is set choose get it, if not get the search.ddo_map if not get the show.ddo_map
		// (!) Result rows are a PICK LIST, never editors: a ddo pinned to edit (an
		// in-cell editable column of the caller's table, e.g. a portal fixed_mode
		// 'edit' view 'line') rendered a whole editable portal — label, tools,
		// pen/remove — inside every result row, breaking the row's text flow.
		// Downgraded to list here, as the filter paths above already are.
		const ddo_map = (request_config_object.choose && request_config_object.choose.ddo_map
			? request_config_object.choose.ddo_map
			: search_ddo_map
		).map(ddo => ddo.mode==='edit' ? {...ddo, mode : 'list'} : ddo)

	// columns. get the sub elements with the ddo_map, the method is recursive,
	// it get only the items that don't has relations and is possible get values (component_input_text, component_text_area, compomnent_select, etc )
		const columns = get_ar_inverted_paths(ddo_map)

	// rqo. Build the request query object
		const rqo = {
			id			: self.id,
			action		: 'read',
			source		: source,
			show		: {
				ddo_map					: ddo_map,
				// value_with_parents	: value_with_parents,
				fields_separator		: fields_separator,
				columns					: columns
			},
			sqo			: sqo,
			sqo_options	: sqo_options
		}


	return rqo
}//end build_rqo_search



/**
* LOAD_DATA_DEBUG
* Render a rich diagnostic view of an API response and its originating RQO into a
* DocumentFragment, using the JsonView tree visualizer.
*
* Only active when SHOW_DEBUG === true and the caller is a section or area instance.
* Renders four collapsible JSON trees into the returned fragment:
*   - `response_debug`: combines response.debug, rqo_show_original, and CSS rule info
*   - `dd_request`: the raw request object from the instance (if present)
*   - `context`: response_data(response).context
*   - `data`: response_data(response).data
*
* The fragment is returned to the caller (typically a section's build or debug panel)
* to be appended wherever appropriate. No direct DOM insertion is performed here.
*
* @param {Object} self - Section or area instance that initiated the API request
* @param {Promise<Object>} load_data_promise - Resolves to the API response object
* @param {Object} rqo_show_original - The RQO that was sent to the API
* @returns {Promise<DocumentFragment|boolean>} The diagnostic fragment, or false when
*   SHOW_DEBUG is off, caller is not a section/area, or the API returned an error
*/
export const load_data_debug = async function(self, load_data_promise, rqo_show_original) {

	// only works if debug mode is active
		if(SHOW_DEBUG===false) {
			return false
		}

	// check caller instance is section or are
		if (self.type!=='section' && self.type!=='area') {
			return false
		}

	// dd_request
		const response		= await load_data_promise
		const dd_request	= self.dd_request

	// load_data_promise response check
		if (request_failed(response)) {
			console.error('API EXCEPTION:', response.error);
			return false
		}
		const datum = response_data(response)

	// fragment
		const fragment = new DocumentFragment();

		// request to API
			// const sqo	= dd_request_show_original.find(el => el.typo==='sqo') || null
			// const sqo	= rqo_show_original.sqo
			// const request_pre	= ui.create_dom_element({
			// 	element_type	: 'pre',
			// 	text_content	: "dd_request sent to API: \n\n" + JSON.stringify(rqo_show_original, null, "  ") + "\n\n\n\n" + "dd_request new built: \n\n" + JSON.stringify(dd_request, null, "  "),
			// 	parent			: fragment
			// })

		// rqo_show_original
			// const rqo_show_original_pre	= ui.create_dom_element({
			// 	element_type	: 'pre',
			// 	text_content	: "rqo_show_original: \n",
			// 	parent			: fragment
			// })
			// render_tree_data(rqo_show_original, rqo_show_original_pre)

		// response_debug
			const combi = {
				'debug'					: response.debug,
				'rqo_show_original'		: rqo_show_original,
				'elements_css_object'	: get_inserted_rules()
			};
			const response_debug_pre = ui.create_dom_element({
				element_type	: 'pre',
				text_content	: "response_debug: \n",
				parent			: fragment
			})
			render_tree_data(combi, response_debug_pre)

		// dd_request
			if (dd_request) {
				const dd_request_pre	= ui.create_dom_element({
					element_type	: 'pre',
					text_content	: "dd_request: \n",
					parent			: fragment
				})
				render_tree_data(dd_request, dd_request_pre)
			}

		// context
			const context_pre = ui.create_dom_element({
				element_type	: 'pre',
				text_content	: "context: \n", // + JSON.stringify(datum.context, null, "  "),
				parent			: fragment
			})
			render_tree_data(datum.context, context_pre)

		// data
			const data_pre = ui.create_dom_element({
				element_type	: 'pre',
				text_content	: "data: \n", // + JSON.stringify(datum.data, null, "  "),
				parent			: fragment
			})
			render_tree_data(datum.data, data_pre)

	// time
		// const time_info = "" +
		// 	"Total time: " + response.debug.real_execution_time +
		// 	"<br>Context exec_time: " + datum.debug.context_exec_time +
		// 	"<br>Data exec_time: " + datum.debug.data_exec_time  + "<br>"

		// const time_info_pre = ui.create_dom_element({
		// 	element_type : "pre",
		// 	class_name   : "total_time",
		// 	id   		 : "total_time",
		// 	inner_html   : time_info,
		// 	parent 		 : fragment
		// })

	// debug node container
		// const debug = document.getElementById("debug")
		// // debug.classList.add("hide")

		// // clean
		// 	while (debug.firstChild) {
		// 		debug.removeChild(debug.firstChild)
		// 	}

		// debug.appendChild(fragment)

		// // show
		// 	debug.classList.remove("hide")

	return fragment
}//end load_data_debug



/**
* RENDER_TREE_DATA
* Load the JsonView library (CSS + JS) on demand and render `data` as an
* interactive collapsible tree inside `target_node`.
*
* The CSS and JS files are loaded in parallel via load_style() / load_script().
* Because script injection is asynchronous and `JsonView` may not be available
* immediately after the load_promises resolve, the function polls by scheduling
* itself recursively with a 500 ms delay until `JsonView` appears on `window`.
* In practice this only occurs on the very first call per page load.
*
* After rendering, `open_main_children` expands all nodes in the tree by calling
* JsonView.expandChildren(). The commented-out depth-limited traversal was a
* previous implementation that only expanded the first three levels.
*
* @param {*} data - Any JSON-serializable value to visualize
* @param {HTMLElement} target_node - DOM node to render the tree into
* @returns {Promise<*>} Resolves to the return value of JsonView.render() once
*   the tree has been fully rendered into target_node
*/
export const render_tree_data = async function(data, target_node) {

	// load dependencies js/css
		const load_promises = []

	// css file load
		const lib_css_file = DEDALO_ROOT_WEB + '/lib/json-view/jsonview.bundle.css'
		load_promises.push( load_style(lib_css_file) )

	// js module import
		// const load_promise = import('../../../lib/json-view/jsonview.bundle.js') // used minified version for now
		const lib_js_file = DEDALO_ROOT_WEB + '/lib/json-view/jsonview.bundle.js'
		load_promises.push( load_script(lib_js_file) )

	// await all promises are done. It not means that lib is available, only started the load
		await Promise.all(load_promises)

	// if is not available, wait to finish load and try again
		if (typeof JsonView==='undefined') {
			return new Promise(function(resolve){
				setTimeout(function(){
					resolve( render_tree_data(data, target_node) )
				}, 500)
			})
		}

	// tree
		const tree = JsonView.createTree(data);

	// render
		const result = JsonView.render(tree, target_node);

	// open main_children level
		function open_main_children(tree) {

			// open all nodes
				JsonView.expandChildren(tree);

			// open only first levels
				// JsonView.traverseTree(tree, function(node) {
				// 	if (node.depth<3) {
				// 		JsonView.showNodeChildren(node)
				// 		node.isExpanded = true;
				// 		// node.el.classList.remove('hide');
				// 		const icon = node.el.querySelector('.fas');
				// 		if (icon) {
				// 			icon.classList.replace('fa-caret-right', 'fa-caret-down');
				// 		}
				// 	}
				// });

			return
		}
		open_main_children(tree);

	return result
}//end render_tree_data



/**
* LOAD_DATA_FROM_DATUM
* Populate `self.data` from the pre-loaded `self.datum` array during the build phase.
* Called by component build methods when data was not injected via init() options.
*
* Resolution logic:
*   - If `self.data` is already set (e.g. injected at init), this is a no-op.
*   - If `self.datum` exists, filter it to the entry matching
*     `tipo === self.tipo AND section_tipo === self.section_tipo AND section_id == self.section_id`.
*     Note the loose equality (`==`) for section_id to handle string/number mismatches.
*   - If `self.datum` is absent, set a minimal empty-value placeholder so downstream
*     render code never needs to null-check self.data.
*
* @returns {Array|Object} self.data — either the matched datum entries or the empty placeholder
*/
common.prototype.load_data_from_datum = function() {

	const self = this

	// load data from datum (use on build only)
		if (!self.data) {
			self.data = self.datum
				? self.datum.filter(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo && el.section_id==self.section_id)
				: {
					tipo			: self.tipo,
					section_tipo	: self.section_tipo,
					section_id		: self.section_id,
					value			: [],
					fallback_value	: [""]
				  }
		}

	return self.data
}//end load_data_from_datum



/**
* REMOVE_NON_INIT_EVENTS
* (dead code — commented out)
* Was intended to unsubscribe events added after init() to prevent duplication
* on refresh cycles. Superseded by the destroy→rebuild pattern in refresh().
* @returns {Array} delete_events
*/
	// export const remove_non_init_events = function(self) {

	// 	return true;

	// 	// const events_tokens			= self.events_tokens || []
	// 	// const events_tokens_init	= self.events_tokens_init || null
	// 	// const delete_events			= events_tokens_init && events_tokens_init.length>0
	// 	// 	? (() =>{
	// 	// 		// delete only non init tokens
	// 	// 		for (let i = 0; i < events_tokens.length; i++) {
	// 	// 			const token = events_tokens[i] // token name
	// 	// 			// console.warn("++++++ token",token)
	// 	// 			if( events_tokens_init.indexOf(token)===-1 ) {
	// 	// 				event_manager.unsubscribe(token)
	// 	// 					console.log("removed event not in events_tokens_init. token:", token, self.id);
	// 	// 			}
	// 	// 		}
	// 	// 	  })()
	// 	// 	: null // events_tokens.map(current_token => event_manager.unsubscribe(current_token)) // remove all

	// 	// return delete_events
	// }//end remove_non_init_events



/**
* SECTION_ELEMENTS_CONTEXT_PROMISES
* Module-level shared cache of get_section_elements_context results, keyed by the
* SAME complete fingerprint the localdb cache_handler id uses (section_tipo +
* application lang + options fingerprint) and holding the request PROMISE, stored
* synchronously BEFORE the first await — so N concurrent callers (same instance
* or different instances) share one request instead of N, and two instances
* asking the same question after page build share one answer.
* The resolved components array is shared by design: every call site treats it as
* read-only (render/find/map), and the previous per-instance cache already
* returned the same array to every repeat caller on one instance.
* A promise that settles empty/failed is evicted so a later call can retry.
* Lang is part of the key, so a language switch can never serve a foreign-lang
* entry even before its page reload clears module state.
* @type {Map<string, Promise<Array<Object>|null>>}
*/
const section_elements_context_promises = new Map()



/**
* GET_SECTION_ELEMENTS_CONTEXT
* Fetch the context list of components associated with a section tipo from the API.
* Results are cached in the module-level `section_elements_context_promises` map
* (shared across instances, keyed by the full query fingerprint), mirrored onto
* `self.components_list[section_tipo]` for the direct readers of that property
* (e.g. render_search), and additionally via the data_manager's 'localdb' cache
* handler under the same fingerprint.
*
* Used by section-level features (e.g. section_record column resolution, inspector
* panel) that need to know which components belong to a section before rendering.
*
* `context_type: 'simple'` requests a lightweight context shape (no deep tool/button
* resolution) suitable for list headers and column configuration.
*
* @param {Object} options - Request options
* @param {string|Array<string>} options.section_tipo - Ontology tipo(s) to query
* @param {Array<string>} [options.ar_components_exclude] - Component tipos to omit
* @param {boolean} [options.use_real_sections] - When true, bypass virtual section merging
* @param {boolean} [options.skip_permissions=false] - When true, include components
*   regardless of the current user's permission level
* @returns {Promise<Array<Object>>} Array of component context objects for the section
*/
common.prototype.get_section_elements_context = async function(options) {

	const self = this

	// section_tipo (string|array)
		const section_tipo			= options.section_tipo
		const ar_components_exclude	= options.ar_components_exclude
		const use_real_sections		= options.use_real_sections
		const skip_permissions		= options.skip_permissions ?? false;

	// check self.components_list
		if (!self.components_list) {
			self.components_list = []
			console.error('Forced add missing self.components_list:', self.components_list);
		}

	// cache key. The COMPLETE query fingerprint — the server answers differently
	// per ar_components_exclude list (search excludes media models, tool_export
	// only component_password, tool_update_cache none), per use_real_sections and
	// per skip_permissions, so every one of them is in the key; an incomplete
	// fingerprint poisons the entry for every other caller of the same
	// section+lang. The same id keys the localdb cache_handler below, so the
	// persisted and in-memory layers can never disagree on identity.
	// (The previous in-memory cache keyed on section_tipo ALONE, so one instance
	// asking twice with different options got the first answer's shape back;
	// skip_permissions was also missing from the persisted fingerprint.)
		const options_fingerprint = (Array.isArray(ar_components_exclude)
			? [...ar_components_exclude].sort().join(',')
			: 'default')
			+ (use_real_sections===true ? '_real' : '')
			+ (skip_permissions===true ? '_skipperm' : '')
	// THE PRINCIPAL IS PART OF THE FINGERPRINT (P2-3 / CLI-15).
	//
	// This envelope is PERMISSION-FILTERED: the server returns the components
	// THIS user may see. The key carried section, lang and options and no user
	// id, and `execute_request` short-circuits on a localdb hit with no session
	// check — so a second user on the same browser profile could be served the
	// first user's filtered component list, and see components their own
	// permissions exclude. `menu.build_cache_id` applies exactly this rule one
	// directory away, reading the same global.
	//
	// 'anon' when absent, deliberately: a DIFFERENT namespace from any logged
	// user, never a shared one. A key that collapses to the old shape when the id
	// is missing is the defect with a suffix.
		const cache_user_id = window.page_globals?.user_id || 'anon'
		const cache_key = 'section_cache_elements_context_' + cache_user_id + '_' + section_tipo + '_' + window.page_globals?.dedalo_application_lang + '_' + options_fingerprint

	// shared cache hit. Concurrent callers arriving before the first request
	// resolves join its promise (it is stored below BEFORE any await); later
	// callers get the settled one. Cross-instance by design.
		const cached_promise = section_elements_context_promises.get(cache_key)
		if (cached_promise) {
			const components = await cached_promise
			// mirror for the direct self.components_list readers (render_search)
			self.components_list[section_tipo] = components
			return components
		}

	// components
		const get_components = async () => {

			const source = create_source(self, null)

			// load data
				const rqo = {
					action			: 'get_section_elements_context',
					prevent_lock	: true,
					source			: source,
					options			: {
						context_type			: 'simple',
						ar_section_tipo			: section_tipo,
						use_real_sections		: use_real_sections,
						ar_components_exclude	: ar_components_exclude,
						skip_permissions		: skip_permissions
					}
				}

				// cache_handler. Cache section elements API response for speed.
				// Same id as the in-memory key above — one identity, two layers.
				const cache_handler = (section_tipo)
					? {
						handler	: 'localdb',
						id		: cache_key
					  }
					  : null;

				const api_response = await data_manager.request({
					body			: rqo,
					cache_handler	: cache_handler
				})

			return response_data(api_response)
		}

	// register the promise SYNCHRONOUSLY (before its first await runs) so every
	// caller in the same tick joins it; evict a settled failure/empty result so
	// a later call can retry instead of caching the outage forever.
		const components_promise = get_components()
		section_elements_context_promises.set(cache_key, components_promise)
		components_promise.then(
			(components) => {
				// EMPTY is an outage, not an answer: a transient `ok:true, result:[]`
				// (e.g. mid ontology edit) would otherwise pin [] in this module-level
				// map for the rest of the page session, and every later caller — search
				// panel, tool_print, tool_export — would render "nothing to render" until
				// a full reload. `length===0` is the same emptiness test render_components_list
				// applies. The per-instance cache this map replaced refetched on a new
				// instance, so pinning [] would be a staleness this change INTRODUCED.
				if (!components || components.length===0) {
					section_elements_context_promises.delete(cache_key)
				}
			},
			() => {
				section_elements_context_promises.delete(cache_key)
			}
		)

	const components = await components_promise

	// mirror for the direct self.components_list readers (render_search)
	self.components_list[section_tipo] = components


	return components
}//end get_section_elements_context



/**
* CALCULATE_COMPONENT_PATH
* Append the current component's path descriptor to an accumulated path array.
* Used when building a multi-level search filter (e.g. clicking through portal
* chains) to incrementally construct the full path from the root to the target
* component.
*
* The returned array represents the traversal path as a sequence of locator objects,
* each identifying a step in the component hierarchy. This path is later passed to
* the SQO `filter.path` field.
*
* HTML tags are stripped from `component_context.label` before storing it in the
* path descriptor (labels may contain markup from rich-text tool definitions).
*
* If `path` is not an array (e.g. undefined or null from a first call), it is
* replaced with an empty array and a warning is logged.
*
* @param {Object} component_context - Context object of the component being added to the path.
*   Expected properties: section_tipo, tipo, ar_target_section_tipo, model, label
* @param {Array<Object>} path - Accumulated path from previous traversal steps
* @returns {Array<Object>} New path array (does not mutate the input `path`)
*/
common.prototype.calculate_component_path = function(component_context, path) {

	if (!Array.isArray(path)) {
		console.log("[calculate_component_path] Fixed bad path as array! :", path);
		path = []
	}

	const calculate_component_path = []

	// Add current path data
	const path_len = path.length
	for (let i = 0; i < path_len; i++) {
		calculate_component_path.push(path[i])
	}

	// Add component path data
	calculate_component_path.push({
		section_tipo			: component_context.section_tipo,
		component_tipo			: component_context.tipo,
		ar_target_section_tipo	: component_context.ar_target_section_tipo,
		model					: component_context.model,
		// path[].name is display TEXT (inert <template> parse, entities decoded):
		// one parse, no incomplete regex strip (CodeQL alert 7940). Every reader renders
		// it as text (render_search.js label_add) — never as markup.
		name					: strip_tags(component_context.label ?? '')
	})

	return calculate_component_path
}//end calculate_component_path



/**
* FORMAT_LABEL
* Fills the `${placeholder}` slots of a UI label with the given values.
*
* Dédalo labels carry their placeholders INLINE (see `choose_page_between` in
* src/core/labels/master.json), so a translator moves them freely inside the
* sentence — which is why a message with values in it must be one label plus
* this call, never string concatenation around a translated fragment.
*
* An unknown placeholder is left untouched: a visible `${foo}` in one language
* is a bug report, a silently truncated sentence is not.
*
* @param {string} template - the label text (a get_label entry, or its literal fallback).
* @param {Object} values - placeholder name → value.
* @returns {string}
*
* @example
* // 'Registry has 2.1.0'
* format_label('Registry has ${v}', {v: '2.1.0'})
*/
export const format_label = function(template, values) {

	return String(template).replace(
		/\$\{(\w+)\}/g,
		(match, key) => (key in values ? String(values[key]) : match)
	)
}//end format_label



/**
* VALIDATE_TIPO
* Validate that a string matches the Dédalo ontology tipo format.
* Valid tipos consist of two or more lowercase letters followed by one or more digits,
* e.g. 'dd345', 'oh1', 'rsc17'. The regex anchors to the full string to reject
* embedded tipos or tipo-like substrings.
*
* @param {string} tipo - The candidate tipo string to validate
* @returns {boolean} true when tipo matches /^[a-z]{2,}[0-9]{1,}$/; false otherwise
*/
export const validate_tipo = function(tipo) {

	if (!tipo) {
		return false
	}

	const regex	= /^[a-z]{2,}[0-9]{1,}$/;
	const res	= regex.exec(tipo)

	const result = (res && res[0]) ? true : false

	return result
}//end validate_tipo



/**
 * GET_FALLBACK_VALUE
 * Get the fallback values when the current language version of the data is missing.
 * When a value exists in entries, uses it directly. When missing, uses the fallback
 * value wrapped in <mark> tags to indicate it's from a fallback language.
 *
 * @param {Array<Object|null>} entries - Current language data (array of objects with .value property or null)
 * @param {Array<Object>} [fallback_value] - Fallback language data to use when entries are missing
 * @returns {Array<string>} Array of values with fallback values marked when used
 *
 * @example
 * // Returns ['Hello', '<mark>Hola</mark>']
 * get_fallback_value(
 *   [{value: 'Hello'}, null],
 *   [{value: 'Hello'}, {value: 'Hola'}]
 * )
 */
export const get_fallback_value = function(entries, fallback_value) {

	const fallback_result	= []
	const value_length		= entries.length > 0
		? entries.length
		: (fallback_value?.length ?? 0)

	for (let i = 0; i < value_length; i++) {

		if( entries[i] ){

			fallback_result.push( entries[i].value )

		}else{

			const fv			= fallback_value?.[i]
			const marked_value	= (fv && fv.value)
				? '<mark>'+fv.value+'</mark>'
				: ''

			fallback_result.push(marked_value)
		}
	}

	return fallback_result
}//end get_fallback_value



/**
* PUSH_BROWSER_HISTORY
* Add a navigation entry to the browser's session history stack using the
* History API. Provides a single canonical call site so all Dédalo navigation
* events produce a consistent state shape.
*
* The `state` object is frozen before being passed to history.pushState() to
* prevent accidental mutation of the stored entry. The state is later read by
* the 'popstate' handler (in page.js) to restore the view on browser back/forward.
*
* `event_in_history: true` signals that the entry represents a user-triggered
* navigation event (e.g. a portal drill-down) rather than a programmatic state
* update, so the popstate handler knows whether to re-trigger events.
*
* @param {Object} options - Navigation options
* @param {Object} options.source - Source descriptor of the navigated instance,
*   e.g. `{model:'section', tipo:'rsc176', ...}`
* @param {Object|null} options.sqo - Search query object active at navigation time,
*   or null when navigating to a non-search view
* @param {boolean} [options.event_in_history=false] - Whether this navigation should
*   fire a navigation event on popstate
* @param {string} [options.title=''] - Page title hint (ignored by most browsers)
* @param {string} [options.url=''] - URL to display in the address bar
* @returns {boolean} true
*/
export const push_browser_history = function(options) {

	// options
		const source			= options.source
		const sqo				= options.sqo
		const event_in_history	= options.event_in_history ?? false
		const title				= options.title || ''
		const url				= options.url || ''

	// state
		const state = Object.freeze({
			user_navigation_options : {
				source				: source, // object
				sqo					: sqo, // object
				event_in_history	: event_in_history // bool
			}
		})

	// history push. Adds an entry to the browser's session history stack.
		history.pushState(
			state, // object state
			title, // string unused (only Safari)
			url // string url optional
		)
		if(SHOW_DEBUG===true) {
			console.log("[common.push_browser_history] -> navigation history state push:", state, title, url);
		}


	return true
}//end push_browser_history



/**
* IS_PAGE_ROOT
* Whether an instance is PAGE scope: the page itself, or an element the page
* instantiated (its caller is the page), or one built standalone with no caller.
* Anything with another caller is EMBEDDED (an inspector block, a portal, a
* tool panel): its failures are panel-scoped and never the page's
* (page_globals.page_error).
* @param {Object} instance
* @returns {boolean}
*/
export const is_page_root = function(instance) {
	if (!instance) return false
	if (instance.model==='page') return true
	return !instance.caller || instance.caller.model==='page'
}//end is_page_root



/**
* BUILD_AUTOLOAD
* Execute the API request that loads context and data for a section, area, or portal
* during its `build` phase. Provides a single canonical call site for the
* load-context-and-data pattern so all top-level containers behave consistently.
*
* If `self.tmp_api_response` is set, it is used directly instead of making a network
* request. This allows refresh() to inject a previously fetched response (e.g. the
* response from a save operation) to avoid a redundant round-trip.
*
* Error handling: the failure envelope carries an ApiError, and
* `handle_api_error` executes its policy (relogin overlay for `auth.not_logged`,
* no-access panel for `perm.denied`, toast for the rest). When it reports
* `recovered:true` — the page's OWN user logged back in (relogin_identity
* 'same'; another identity reloads the page) — the request is re-sent once,
* unless the page holds unsaved data. While the page identity is revoked
* (error_dispatch is_page_identity_revoked) nothing is sent. On every failure
* path — the latch included — status is reset to `previous_status`
* ('initialized') and false is returned so the calling build() knows to abort.
*
* Developer mode logging: when SHOW_DEVELOPER or SHOW_DEBUG is true, the raw
* api_response is logged to the console. Errors are additionally highlighted.
*
* @param {Object} self - The Dédalo instance (area, section, or component_portal)
*   that owns `self.rqo` (the pre-built request query object) and `self.status`
* @param {Object} [options]
* @param {boolean} [options.recovery_retry=false] - internal: this call is the one
*   re-send after a recovered auth failure (re-login); it never retries again
* @returns {Promise<Object|boolean>} The raw api_response object on success, or false
*   when the response is missing/invalid or a known error was handled
*/
export const build_autoload = async function(self, {recovery_retry=false}={}) {

	// page identity guard (LEAD-2 + CLIENT-5): a re-login on this page
	// authenticated another (or an unresolvable) identity — the reload is pending
	// or was cancelled. No read is sent under that session into this page's
	// state; the build is aborted like any other failed load — status reset to
	// 'initialized' as the failure tail below does, or a render() waiting on
	// this 'building' instance would wait for a 'built_' event that never fires.
		if (!self.tmp_api_response && is_page_identity_revoked()) {
			console.warn(`${self.model} build refused: the page identity changed on re-login; reload the page.`)
			self.build_error = null
			self.status = 'initialized'
			return false
		}

	// load context and data
		const api_response = self.tmp_api_response || await data_manager.request({
			body : self.rqo
		})

	// build_error. The request's ApiError, kept so a caller that only sees
	// build()===false can say what actually failed (render_build_failure)
	// instead of guessing permissions. null on success / empty-data answers.
		self.build_error = request_failed(api_response) ? api_response.error : null

	// debug last server error. Only for development
		if(SHOW_DEVELOPER===true || SHOW_DEBUG===true) {
			if (request_failed(api_response)) {
				console.error(`${self.model} build api_response failed [${api_response.error.code}]:`, JSON.parse( JSON.stringify(api_response) ) );
			}else{
				console.log(`${self.model} build api_response:`, JSON.parse( JSON.stringify(api_response) ) );
			}
			if (api_response && api_response.dedalo_last_error) {
				console.error('SERVER: api_response.dedalo_last_error:', api_response.dedalo_last_error);
				// // notification.
				// // Fires a notification event that is listened by page and rendered in bubbles_notification_container
				// if (api_response.dedalo_last_error) {
				// 	event_manager.publish('notification', {
				// 		msg			: api_response.dedalo_last_error,
				// 		type		: 'error',
				// 		remove_time	: 10000 // 10 secs
				// 	})
				// }
			}
		}

	// response check
		if (request_failed(api_response) || !response_data(api_response)) {

			// previous_status
				const previous_status = 'initialized'

			// status update. Set BEFORE the (awaited) dispatch so a rebuild
			// triggered by the recovery starts from a coherent state.
				self.status = previous_status // 'initialized' or 'rendered'

			// THE handler. The policy decides the surface (relogin overlay,
			// no-access panel, toast); `recovered` is true only when the cause
			// is gone — today that means the user logged back in.
				if (request_failed(api_response)) {
					// page_scope: only a page-root element's refusal is the PAGE's
					// failure (page_globals.page_error); an embedded one is panel-local:
					// its caller renders the build()===false answer, or render() of this
					// failed instance draws it (see common.prototype.render).
					const {recovered} = await handle_api_error(api_response.error, {
						wrapper		: self.node,
						page_scope	: is_page_root(self)
					})
					// Recovered (re-login): re-send the SAME request and hand its answer
					// back to the build() in flight. (!) Never a nested build()+render()
					// here: that rendered a second copy, reset build_error, and this
					// function still answered false — so the caller painted a phantom
					// "permissions" banner over a page that had in fact loaded.
					// One retry only (`recovery_retry`): a second auth failure stops.
					if (recovered===true && !(window.unsaved_data ?? false) && recovery_retry!==true) {
						self.tmp_api_response = undefined
						return build_autoload(self, {recovery_retry: true})
					}
				}

			return false
		}//end if (request_failed(api_response) || !response_data(api_response))

	// per-occurrence chains (owner decision (b)) are relative to THIS read's
	// root: tag them before any consumer matches a cell (root_caller_chains)
		root_caller_chains(response_data(api_response), self)


	return api_response
}//end build_autoload



/**
* SET_ENVIRONMENT
* Apply the server-emitted environment payload to the browser global scope.
* Replaces the old `environment.js.php` server-rendered file with a single
* API call + client-side assignment pattern.
*
* The payload is a plain object whose keys map to one of three handling strategies:
*
*   'plain_vars'  — each key of the nested value object is assigned directly to
*     `window` (e.g. `window.DEDALO_CORE_URL = '/v7/core'`). These are constants
*     referenced by modules as bare globals (see the /*global …* / annotation in
*     each module).
*
*   'page_globals' — the nested object is merged into the existing `page_globals`
*     module-level variable via Object.assign so existing keys are overwritten and
*     new keys are added without replacing the reference.
*
*   'get_label' — IGNORED. The label dictionary is no longer part of the
*     environment: it is its own versioned resource loaded by labels.js
*     `load_labels()` (WC-2026-11-07-labels-separate-resource). A stray key must
*     never overwrite the loaded dictionary through the default branch.
*
*   anything else — the entire value is assigned to `window[key]`.
*
* @todo Consider consolidating all env vars under a single `window.dd_environment`
*   namespace to avoid polluting window directly.
*
* @param {Object} api_response_environment - Environment payload from the API
* @param {Object} [api_response_environment.plain_vars] - Flat constant assignments
* @param {Object} [api_response_environment.page_globals] - Runtime globals to merge
* @returns {void}
*/
export const set_environment = function (api_response_environment) {

	// set vars as global
	for (const [key, value] of Object.entries(api_response_environment)) {
		switch (key) {
			case 'plain_vars':
				// assign one by one
				for (const property in value) {
					window[property] = value[property]
				}
				break;

			case 'page_globals':
				// assign to existing object
				page_globals = Object.assign(page_globals, value);
				break;

			case 'get_label':
				// not an environment key any more (labels.js load_labels owns get_label)
				break;

			default:
				// set whole value
				window[key] = value
				break;
		}
	}
}//end set_environment



/**
* RENDER_PROCESS_STATUS_FAILURE
* The panel's statement of a status stream that could not be opened: label-first
* (error_text), the server's own sentence when it says more, the request_id (the
* join key with the server log). Panel-local — never the full-page panel. Text
* nodes only: server text never reaches an HTML sink.
* @param {ApiError} api_error
* @returns {HTMLElement}
*/
const render_process_status_failure = function (api_error) {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'api_response error process_status_failure'
	})
	node.dataset.code = String(api_error?.code || '')

	const headline	= String(error_text(api_error)) + error_debug_suffix(api_error)
	const message	= typeof api_error?.message === 'string' ? api_error.message : ''
	const lines		= [headline]
	if (message.length && !headline.startsWith(message)) {
		lines.push(message)
	}
	if (typeof api_error?.request_id === 'string' && api_error.request_id.length) {
		lines.push('request_id: ' + api_error.request_id)
	}
	lines.forEach((line, i) => {
		if (i > 0) node.appendChild(document.createElement('br'))
		node.appendChild(document.createTextNode(line))
	})

	return node
}//end render_process_status_failure



/**
* UPDATE_PROCESS_STATUS
* Poll a long-running server process via SSE (Server-Sent Events) and update
* a DOM container with live status information as each chunk arrives.
*
* Sends a streaming request to the `dd_utils_api / get_process_status` endpoint.
* The server pushes one SSE event per `update_rate` milliseconds until the process
* identified by `pid` / `pfile` finishes or is cancelled.
*
* Rendering is handled by `render_stream()` which builds the base status UI nodes
* inside `container`. As each SSE chunk arrives, `update_info_node()` updates the
* display. When the stream closes, `done()` finalizes the UI and the optional
* `callback` is invoked.
*
* Input validation is performed up-front:
*   - `container` must be a valid HTMLElement (aborts with a console.error if not).
*   - `id`, `pid`, `pfile` types are checked; a console.error is emitted and the
*     function returns early on mismatch.
*   - `update_rate` must be a positive number; defaults to 1000ms with a warning.
*
* @param {string} id - Unique string identifier for the process (used by render_stream)
* @param {string|number} pid - OS or server-side process ID to monitor
* @param {string} pfile - Path to the process status file on the server
* @param {HTMLElement} container - DOM element to render status updates into
* @param {number} [update_rate=1000] - Polling interval in milliseconds
* @param {Function} [callback] - Called EXACTLY ONCE when the tracking ends: with the
*   LAST frame read (null when none arrived) when the stream finishes — a caller
*   that acts on the outcome (the move_* preview → execute gate) reads it instead
*   of re-polling — or, when the stream could not be OPENED (fetch rejected,
*   non-2xx, no body), with a terminal frame `{is_running:false, error:ApiError}`
*   (read it with normalize_stream_error); the failure is then also stated in
*   `container`, panel-local (never page_globals.page_error).
* @returns {void}
*/
export const update_process_status = function (id, pid, pfile, container, update_rate=1000, callback) {

	// Validate essential parameters
	if (!container || !(container instanceof HTMLElement)) {
		console.error('Error: "container" must be a valid HTMLElement.');
		return;
	}
	if (typeof id !== 'string' || (typeof pid !== 'string' && typeof pid !== 'number') || typeof pfile !== 'string') {
		console.error('Error: Invalid id, pid, or pfile types.');
		return;
	}
	if (typeof update_rate !== 'number' || update_rate <= 0) {
		console.warn('Warning: Invalid update_rate. Using default 1000ms.');
		update_rate = 1000;
	}

	if(SHOW_DEBUG===true) {
		console.log(`Initiating process status update for ID: ${id}, PID: ${pid}`);
	}

	// settle: THE single terminal path. The callback runs EXACTLY ONCE however
	// the tracking ends — the stream finished, or it could never be opened.
	// (!) An open failure (fetch rejected, a non-2xx answer, a 2xx without body)
	// used to be logged and dropped: the callback never ran, so a caller gating
	// on it (the move_* preview → execute, update_code's track) waited forever.
	let settled = false
	const settle = (frame) => {
		if (settled===true) {
			return
		}
		settled = true
		if (callback && typeof callback === 'function') {
			callback(frame)
		}
	}

	// fail_open: the stream could not be opened. No reader exists (none to
	// release). The failure is stated IN the panel — panel-local, never the page
	// slot (page_globals.page_error belongs to the page's own requests) — and the
	// caller is settled with a terminal frame carrying the coded failure, the
	// shape normalize_stream_error reads. The page-wide policy (relogin on
	// auth.*) already ran: request_stream publishes every failure's ApiError.
	const fail_open = (api_error) => {
		console.error(`Stream request for ID: ${id}, PID: ${pid} failed:`, api_error?.code, api_error);
		// client.aborted is silent by policy (the caller's own abort, a revoked
		// page identity): nothing to state, but the caller still settles
		if (api_error.code !== CLIENT_ERROR.ABORTED) {
			container.replaceChildren(render_process_status_failure(api_error))
		}
		settle({
			is_running	: false,
			error		: api_error
		})
	}

	// get_process_status from API and returns a SSE stream
	data_manager.request_stream({
		body : {
			dd_api		: 'dd_utils_api',
			action		: 'get_process_status',
			update_rate	: update_rate, // int milliseconds
			options		: {
				pid		: pid,
				pfile	: pfile
			}
		}
	})
	.then((stream) => {

		// render base nodes and set functions to manage
		// the stream reader events
		const render_stream_response = render_stream({
			container		: container,
			id				: id,
			pid				: pid,
			pfile			: pfile,
			display_json	: true
		})

		// last frame read, handed to the optional callback on done
		let last_response = null

		// on_read event (called on every chunk from stream reader)
		const on_read = (sse_response) => {
			last_response = sse_response
			// fire update_info_node on every reader read chunk
			render_stream_response.update_info_node(sse_response)
		}

		// on_done event (called once at finish or cancel the stream read)
		const on_done = () => {

			// is triggered at the reader's closing
			render_stream_response.done()

			// optional callback on done
			settle(last_response)
		}

		// read stream. Creates ReadableStream that fire
		// 'on_read' function on each stream chunk at update_rate
		// (1 second default) until stream is done (PID is no longer running)
		data_manager.read_stream(stream, on_read, on_done)
	}, (error) => {
		// request_stream rejects with an ApiError (its @throws contract)
		fail_open(is_api_error(error)
			? error
			: new ApiError({code: CLIENT_ERROR.BAD_RESPONSE, details: {reason: 'stream_open'}, source: 'stream', raw: error}))
	})
	.catch(function(error) {
		// a throw while wiring the stream (render_stream, getReader) — before any
		// reader could end it — must settle the caller too. Once settled, a throw
		// here is the caller's own callback: report it as that, never re-settle.
		if (settled===true) {
			console.error('update_process_status: the caller callback threw', error);
			return
		}
		fail_open(new ApiError({code: CLIENT_ERROR.RENDER_FAILED, details: {reason: 'process_status'}, source: 'client', raw: error}))
	});
}//end update_process_status



// @license-end
