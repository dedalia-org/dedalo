// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_LOCK_COMPONENTS, DEDALO_CORE_URL, DEDALO_NOTIFICATION, Promise */
/*eslint no-undef: "error"*/



/**
* PAGE
* Top-level application shell that orchestrates the Dédalo single-page application (SPA).
*
* Responsibilities:
* - Bootstraps the page on first load: calls the PHP `start` API action, hydrates
*   `page_globals` environment variables, and sets `self.context` from the API response.
* - Manages the active page element (section, area, tool) lifecycle — instantiating,
*   rendering, and destroying instances on each menu-driven navigation.
* - Subscribes to application-wide events (user_navigation, activate_component,
*   dedalo_notification, render_page, render_instance, notification, quit,
*   change_lang, api_error) and dispatches to the correct handler.
* - Owns global keyboard shortcuts (Escape, ArrowLeft/Right with Shift, Ctrl+I, Enter).
* - Registers itself as `window.dd_page` so other modules can reach the shell without
*   an ES-module import cycle.
*
* Prototype methods are mixed in from:
*   - render_page.prototype.edit  — builds the page DOM wrapper
*   - common.prototype.render     — shared render orchestration
*   - common.prototype.refresh    — shared rebuild-from-existing-context cycle
*   - common.prototype.destroy    — base teardown (overridden locally to also remove
*                                   global window/document listeners)
*
* `self.context` is an Array of context objects, each describing a top-level page
* element (menu, section, tool, …). On navigation the array is pruned to keep only
* static elements (menu) plus the newly requested source.
*
* Main exports: {page} constructor, {instantiate_page_element} helper.
*/



// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {get_instance,get_all_instances} from '../../common/js/instances.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {common, push_browser_history, set_environment} from '../../common/js/common.js'
	import {ui} from '../../common/js/ui.js'
	import {
		find_up_node,
		url_vars_to_object,
		JSON_parse_safely,
		object_to_url_vars,
		generate_hash
	} from '../../common/js/utils/index.js'
	import {render_node_info, prepend_bubble} from '../../common/js/utils/notifications.js'
	import {mount_request_activity_indicator} from './request_activity_indicator.js'
	import {cookie_manager} from '../../common/js/utils/cookie_manager.js'
	import {check_unsaved_data, deactivate_components} from '../../component_common/js/component_common.js'
	import {ApiError, CLIENT_ERROR, request_failed, response_data, response_extension} from '../../common/js/api_error.js'
	import {handle_api_error, handle_api_notices, refused_by_page_identity} from '../../common/js/error_dispatch.js'
	import {error_text, render_error_modal} from '../../common/js/render_api_error.js'
	import {init_session_expiry} from '../../common/js/session_expiry.js'
	import {prune_orphan_rules,get_inserted_rules} from '../../page/js/css.js'
	import {render_page, render_notification_msg} from './render_page.js'



/**
* PAGE
* Page shell constructor. Declares the instance properties that every page instance
* carries; all meaningful initialisation is deferred to `init()` and `build()`.
*
* Properties declared here (populated during init/build):
*   id                       — unique instance identifier (set by common infrastructure)
*   model                    — always 'page'
*   mode                     — active rendering mode; currently always 'edit'
*   node                     — root HTMLElement created by render_page.prototype.edit
*   ar_instances             — Array of active child instances (menu, section, tools, …)
*   context                  — Array of context objects received from the PHP API
*   status                   — lifecycle string: 'initializing' | 'initialized' | 'building' | 'built' | 'rendered'
*   events_tokens            — Array of event_manager subscription tokens for later unsubscription
*   last_dedalo_notification — most-recently received dedalo_notification payload {Object}
*/
export const page = function () {

	this.id

	this.model
	this.mode
	this.node
	this.ar_instances
	this.context
	this.status
	this.events_tokens
	this.last_dedalo_notification // object
}//end page



/**
* COMMON FUNCTIONS
* Extend page with shared prototype methods from render_page and common modules.
* Individual method docs live in their respective source files.
*/
// prototypes assign
	page.prototype.edit		= render_page.prototype.edit
	page.prototype.render	= common.prototype.render
	page.prototype.refresh	= common.prototype.refresh
	page.prototype.destroy	= common.prototype.destroy



/**
* RESTORE_SECTION_SELECTION
* Reads local_db `last_section_selection_<section_tipo>` and re-activates the
* matching component if it is present in the current instance list.
*
* This preserves the user's component selection across pagination and full-page
* re-renders. It is called after `render_page` and after `render_instance` events
* (see the handlers registered in `init`).
*
* @param {string} section_tipo - Ontology tipo of the section whose selection to restore
* @returns {Promise<boolean>} true when a component was found and activated, false otherwise
*/
page.prototype.restore_section_selection = async function(section_tipo) {

	const self = this

	// get local db last_section_selection info for current section
		const status_data = await data_manager.get_local_db_data(
			'last_section_selection_' + section_tipo,
			'status'
		)
		if (!status_data) {
			return false
		}

	// find component in page all instances, retrying briefly while the section
	// instances are still being built after the render event (portals/relations
	// resolve async, so the target may not be registered on the first tick).
		const target_tipo	= status_data.value.tipo
		const find_component = () => get_all_instances().find(el =>
			el.tipo === target_tipo &&
			el.section_tipo === section_tipo
		)
		let component	= find_component()
		let attempts	= 0
		while (!component && attempts < 10) {
			await new Promise(resolve => setTimeout(resolve, 100))
			component = find_component()
			attempts++
		}
		if (!component) {
			return false
		}

	// activate component (auto-focus). No-op when it is already active.
		await ui.component.activate(component, true)

	// ensure the restored component is visible.
	// activate()'s focus/scroll is click-oriented (block:'nearest', a no-op when
	// already visible; input components rely on focus()'s implicit scroll) and it
	// races the section layout still settling after the render event — which left
	// the restored component selected but off-screen. Own the scroll here so the
	// recovered selection is always brought into view.
		self.scroll_component_into_view(component)

	return true
}//end restore_section_selection



/**
* SCROLL_COMPONENT_INTO_VIEW
* Brings a component wrapper into the viewport when it is not already fully
* visible. Used by restore_section_selection to guarantee the recovered
* selection ends up on screen regardless of component type.
*
* Deferred two animation frames so the post-render layout has settled before
* measuring (heights grow as data/relations paint); re-checks component.active
* and DOM connection so a selection change between schedule and execution does
* not scroll a stale target. Only scrolls when the wrapper is not fully within
* the viewport, matching "scroll if needed".
*
* @param {Object} component - The component instance whose node to reveal
* @returns {boolean} false when there is no scrollable node, true otherwise
*/
page.prototype.scroll_component_into_view = function(component) {

	const node = component?.node
	if (!node || typeof node.scrollIntoView!=='function') {
		return false
	}

	// double rAF: wait for the post-render layout to settle before measuring
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {

				if (component.active!==true || !node.isConnected) {
					return
				}

				const rect			= node.getBoundingClientRect()
				const view_h		= window.innerHeight || document.documentElement.clientHeight
				const fully_visible	= rect.top >= 0 && rect.bottom <= view_h
				if (!fully_visible) {
					// components taller than the viewport align to the top so the
					// label/first field shows; otherwise centre the wrapper.
					const block = rect.height > view_h ? 'start' : 'center'
					node.scrollIntoView({ block: block, inline: 'nearest' })
				}
			})
		})

	return true
}//end scroll_component_into_view



/**
* INIT
* Wires up the application shell: sets instance properties, subscribes to all
* page-level events, attaches global DOM listeners, and applies platform CSS.
*
* Must be called exactly once per page instance. A guard (`this.is_init`) detects
* and logs duplicate calls — an alert is shown in DEBUG mode because duplicates
* usually indicate a runaway event subscription.
*
* Event subscriptions registered here (tokens stored in `self.events_tokens`):
*   'user_navigation'      → delegates to the private `navigate()` function
*   'activate_component'   → fires lock-component worker request when
*                            DEDALO_LOCK_COMPONENTS is enabled
*   'dedalo_notification'  → calls render_notification_msg via idle callback
*   'render_page'          → restores section selection after full renders
*   'render_instance'      → restores section selection after pagination
*   'notification'         → prepends inspector bubble to bubbles_notification_container
*                            (identical bubbles merge into one with a ×N count)
*
* Also mounts the slow-server cue (request_activity_indicator.js), which
* subscribes to 'request_activity' itself.
*   'quit'                 → calls delete_cache to clear local storage
*   'change_lang'          → calls delete_cache so stale translations are dropped
*   'api_error'            → hands the ApiError to the policy (relogin, no-access, toast)
*   'api_notices'          → hands a SUCCESS envelope's notices[] to the same policy
*
* After subscribing, `add_events()` attaches global window/document listeners and
* `set_custom_css()` applies OS-specific body classes.
*
* @param {Object} options - Initialisation options
* @param {Array}  options.context   - Array of page context objects (section, menu, …)
* @param {Object} options.menu_data - Pre-fetched menu data (may be null on first load)
* @returns {Promise<boolean>} always true on success; false only on duplicate-init guard
*/
page.prototype.init = async function(options) {

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

	// set vars
		self.model			= 'page'
		self.type			= 'page'
		self.mode			= 'edit' // mode like 'section', 'tool', 'thesaurus'...
		self.node			= null
		self.ar_instances	= []
		self.context		= options.context // mixed items types like 'sections', 'tools'..
		self.status			= null
		self.events_tokens	= []
		self.menu_data		= options.menu_data

	// internal state
		self.navigation_in_progress = false

	// events subscriptions

		// event user_navigation. Menu navigation (not pagination)
			const user_navigation_handler = (user_navigation_options) => {
				navigate.bind(this)(user_navigation_options)
			}
			self.events_tokens.push(
				event_manager.subscribe('user_navigation', user_navigation_handler)
			)

		// event activate_component
			const activate_component_handler = function(component_instance) {

				// lock_component. launch worker
				if (typeof DEDALO_LOCK_COMPONENTS!=='undefined' && DEDALO_LOCK_COMPONENTS===true && takes_lock(component_instance)) {
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
										action			: 'focus' // delete_user_section_locks|blur|focus
									}
								}
							})
							.then(function(api_response){

								if (api_response.in_use===true) {
									document.activeElement.blur()

									ui.component.deactivate(component_instance)

									// clean previous locks of current user in current section
										data_manager.request({
											use_worker	: true,
											body		: {
												dd_api			: 'dd_utils_api',
												action			: 'update_lock_components_state',
												prevent_lock	: true,
												options			: {
													component_tipo	: null,
													section_tipo	: component_instance.section_tipo,
													section_id		: null,
													action			: 'delete_user_section_locks' // delete_user_section_locks|blur|focus
												}
											}
										})

									// show warning
									// NOT a failure: the server answered `ok` and says the
									// component is held by someone else. It is rendered
									// through the ONE error renderer anyway — text-only DOM
									// (the message names a user) and the same surface the
									// `record.in_use` policy prescribes (action `modal`).
										const lock_modal = render_error_modal(
											new ApiError({
												code		: 'record.in_use',
												message		: response_extension(api_response, 'msg'),
												severity	: 'warning'
											}),
											{header: get_label.warning || 'Warning'}
										)

									// notify-on-release poll. Watch the locked component until the
									// holder releases it (or their lock expires server-side), then
									// dismiss the warning and return focus to the now-free field.
									// Bounded to ~60s so an abandoned attempt stops polling.
										if (self.lock_release_poll_interval) {
											clearInterval(self.lock_release_poll_interval)
										}
										let lock_poll_attempts = 0
										self.lock_release_poll_interval = setInterval(
											() => {
												if (++lock_poll_attempts > 20) { // ~60s ceiling (20 × 3s)
													clearInterval(self.lock_release_poll_interval)
													self.lock_release_poll_interval = null
													return
												}
												data_manager.request({
													use_worker	: true,
													body		: {
														dd_api			: 'dd_utils_api',
														action			: 'get_lock_status',
														prevent_lock	: true,
														options			: {
															component_tipo	: component_instance.tipo,
															section_tipo	: component_instance.section_tipo,
															section_id		: component_instance.section_id
														}
													}
												})
												.then((status_response) => {
													if (status_response && status_response.in_use===false) {
														clearInterval(self.lock_release_poll_interval)
														self.lock_release_poll_interval = null
														if (lock_modal && typeof lock_modal.on_close==='function') {
															lock_modal.on_close()
														}
														ui.component.activate(component_instance)
													}
												})
											},
											3000 // poll every 3s
										)
								}

								// dedalo_notification from config file
								// update page_globals
								page_globals.dedalo_notification = api_response.dedalo_notification || null
								// dedalo_notification from config file
								event_manager.publish('dedalo_notification', page_globals.dedalo_notification)
							})
						}
					)
				}
			}//end activate_component_handler
			self.events_tokens.push(
				event_manager.subscribe('activate_component', activate_component_handler)
			)

		// event dedalo_notification
			const dedalo_notification_handler = (data) => {
				dd_request_idle_callback(
					() => render_notification_msg(self, data)
				)
			}//end dedalo_notification_handler
			self.events_tokens.push(
				event_manager.subscribe('dedalo_notification', dedalo_notification_handler)
			)

		// event render
			const render_page_handler = () => {
				dd_request_idle_callback(
					async () => {
						// only edit mode is used. Ignore others
						if (self.mode!=='edit') {
							return
						}
						// section_context from page context
						const section_context = self.context.find(el => el.model==='section')
						if (!section_context) {
							return
						}
						// restore last section selection
						self.restore_section_selection(section_context.tipo)
					}
				)
			}
			self.events_tokens.push(
				event_manager.subscribe('render_page', render_page_handler)
			)

		// event render_instance. Used by section pagination navigation
		// to persist the active component selection across page changes
			const render_instance_handler = (instance) => {
				dd_request_idle_callback(
					async () => {
						// only edit mode is used. Ignore others
						if (self.mode!=='edit') {
							return
						}
						// only when a section is re-rendered after pagination
						if (!instance || instance.model!=='section') {
							return
						}
						// restore last section selection
						self.restore_section_selection(instance.tipo)
					}
				)
			}
			self.events_tokens.push(
				event_manager.subscribe('render_instance', render_instance_handler)
			)

		// event notifications. Render inspector bubbles into the activity container.
			// Mainly used to inform users that a network error has occurred.
			// @see data_manager render_msg_to_inspector for other uses.
			// @see common.build_autoload case use
			const notifications_handler = (options) => {
				dd_request_idle_callback(
					() => {
						// container
							const container	= self.bubbles_notification_container
							if (!container) {
								console.log('Warning. bubbles_notification_container is undefined!');
								return
							}

						// render notification bubble
							const node_info = render_node_info(options)

						// prepend node (at top of the list), merging an identical one
							prepend_bubble(container, node_info)
					}
				)
			}
			self.events_tokens.push(
				event_manager.subscribe('notification', notifications_handler)
			)

		// slow-server cue
			// A STATE, not a notification: one top-edge bar (+ one sentence after a
			// long wait) driven by data_manager's request_activity, gone the instant
			// the last request settles. Document-level and idempotent.
			mount_request_activity_indicator()

		// event quit
			const quit_handler = () => {
				self.delete_cache()
			}
			self.events_tokens.push(
				event_manager.subscribe('quit', quit_handler)
			)

		// event change_lang
			const change_lang_handler = () => {
				self.delete_cache()
			}
			self.events_tokens.push(
				event_manager.subscribe('change_lang', change_lang_handler)
			)

		// event api_error
			// THE failure channel: data_manager publishes one ApiError per failed
			// call and the policy (error_policy.js) decides what the page does with
			// it — relogin on `auth.not_logged`, no-access panel on `perm.denied`,
			// toast on the rest. The page no longer inspects tokens itself.
			// (error_dispatch owns the "never a SECOND login" rule and the single
			// overlay shared by every request that failed at once.)
			// (!) EVERY failed request of the page passes here — an embedded panel's
			// as much as the page's own — so this listener is never PAGE scope: it
			// must not set page_globals.page_error (page_scope:false). The page's
			// own failures set it where they happen (build, the page-root
			// element's build_autoload).
			// Answers the dispatch promise, so a publisher (a gate) can await the
			// decision instead of a timer.
			const api_error_handler = (api_error) => {
				return handle_api_error(api_error, {scope:'page', page_scope:false})
			}
			self.events_tokens.push(
				event_manager.subscribe('api_error', api_error_handler)
			)

		// event api_notices
			// The NOTICE channel (ERRORS_SPEC §3): a SUCCESSFUL call may carry
			// `notices[]` — coded, non-fatal facts (children refused on a delete, a
			// degraded external source, a login soft warning). Subscribed ONCE here
			// so no tool has to remember to look: the policy table decides per code
			// (default toast/warning; a widget that renders the fact itself registers
			// its domain as `silent`). Callers that want the notice next to their own
			// wrapper read `api_response.notices` and call handle_api_notice directly.
			const api_notices_handler = (payload) => {
				handle_api_notices(payload)
			}
			self.events_tokens.push(
				event_manager.subscribe('api_notices', api_notices_handler)
			)

		// session expiry warning
			// WC-051: warn before the session dies, so the re-login modal above is
			// the fallback rather than the first the user hears of it. Inert when
			// logged out or when the operator set SESSION_WARNING_SECONDS=0.
			init_session_expiry()

	// events listeners. Add window/document general events
		self.add_events()

	// css. Update custom CSS based on environment
		set_custom_css()

	// set page instance as global to be available
		window.dd_page = self

	// status update
		self.status = 'initialized'


 	return true
}//end init



/**
* SET_PAGE_ERROR
* THE page-level failure slot: `page_globals.page_error`, ONE ApiError, which
* common.prototype.render reads to draw the page panel.
* @param {ApiError} api_error
* @return bool always false, so callers can `return set_page_error(…)`
*/
/**
* TAKES_LOCK
* Whether an active component holds a component soft-lock (focus + heartbeat).
* (!) The id badge is selectable but has nothing to edit: it never locks, or a
* second user would get an 'in use' modal over the record's identity.
* @param object component
* @return bool
*/
const takes_lock = (component) => component.mode==='edit' && component.model!=='component_section_id'



const set_page_error = function(api_error) {

	page_globals.page_error = api_error

	return false
}//end set_page_error



/**
* BUILD
* Fetches and validates the initial page context from the PHP API when `autoload`
* is true (first page load), or verifies that a pre-supplied context is valid.
*
* When `autoload === true` the method:
* 1. Reads URL search params to determine the `with_menu` flag (defaults to true
*    when the `menu` param is absent).
* 2. Sends a `start` action to the default API to receive context + environment.
* 3. Calls `set_environment()` to inject API-supplied vars (`page_globals`,
*    `get_label`, `DEDALO_ENVIRONMENT`, etc.) into the window scope.
* 4. Validates the response at three levels: missing result, missing environment,
*    and missing DEDALO_ENVIRONMENT global — each pushes a descriptive entry to
*    `page_globals.page_error` and returns false so
*    the caller can render an error page.
* 5. Sets `self.context` and `self.data` from the validated response.
*
* When `autoload === false` the caller is expected to have already set `self.context`
* (e.g. from a prior navigation cycle). This path only validates that context exists.
*
* (!) Calling `build(autoload=true)` when `self.context` already exists is treated
* as an error: the call is logged and ignored.
*
* @param {boolean} [autoload=false] - When true, fetches context from the API
* @returns {Promise<boolean>} true when build succeeded; false on any error
*/
page.prototype.build = async function(autoload=false) {

	const self = this

	// status update
		self.status = 'building'

	// (!) Note that normally page only needs load once. Later, only sections/areas will be updated
		if (autoload===true) {

			if (self.context) {
				// catch invalid call. Page build must be false except the first start page
				console.error('Error. Ignored call to page build with autoload=true. Page already have context!', self.context);
			}else{

				// searchParams
				const searchParams = new URLSearchParams(window.location.search);

				// with_menu. Boolean value about if URL contains menu param. If not, the menu is added by default.
				const with_menu = searchParams.has('menu')
					? JSON_parse_safely(
						searchParams.get('menu'), // string from url
						true // fallback on exception parsing string
					  )
					: true

				// cache_handler. 'dedalo_logged' cookie is set in server side on login
					// const local_page_data_id = 'page_cache_' + generate_hash(searchParams.toString())
					// const dedalo_logged = cookie_manager.get('dedalo_logged') || false;
					// const cache_handler = dedalo_logged
					// 	? {
					// 		handler	: 'localdb',
					// 		id		: local_page_data_id
					// 	  }
					// 	: null

				// start bootstrap
					const rqo = { // rqo (request query object)
						action			: 'start',
						prevent_lock	: true,
						options : {
							search_obj	: url_vars_to_object(location.search),
							menu		: with_menu //  bool
						}
					}

				// request page context (usually menu and section/area context)
					const api_response = await data_manager.request({
						body				: rqo,
						// cache_handler	: cache_handler
					});
					if(typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) {
						console.log('))) page build api_response:', api_response);
					}

				// errors check
				// AUTHORIZATION refusal (WC-2026-08-12-authorization-denial-token).
				// The server answers a page the user holds no grant for with HTTP 403
				// + `error.code:'perm.denied'`. It is a normal answer, not a
				// malfunction: it gets its own error type so the renderer can say so
				// in the user's language, instead of the generic "check your server
				// log" panel that used to read "Not retry-able HTTP error 403".
					if (request_failed(api_response) && api_response.error.code==='perm.denied') {

						// The refusal carries the environment (start is the first call —
						// without it there is no get_label and the message could only be
						// rendered in the source language). Inject it exactly like the
						// success path below, so the panel speaks the user's language.
						if (api_response.environment?.result) {
							set_environment(api_response.environment.result)
						}

						// policy `perm.denied` → no_access_page: sets page_globals.page_error
						// with the label in the user's language, so
						// common.prototype.render draws the no-access panel.
						await handle_api_error(api_response.error, {scope:'page build', page_scope:true})

						return false
					}

				// error generic case starting the page
				// start_data. THE payload accessor (the envelope's `data`)
				const start_data = response_data(api_response)

				if (request_failed(api_response) || !start_data) {
					// api_response does not exist, or it is a failure envelope
					console.error('!!! STOP build: page build api_response:', api_response);
					// API start_error. The server's own ApiError when there is one;
					// a client-side one when the answer was not an envelope at all.
					// Every coded page fault arrives HERE — `request.invalid_tipo`
					// included (it used to be grepped out of the prose in `errors[]`
					// further down); the panel renders its label in the user's language.
					return set_page_error(
						request_failed(api_response)
							? api_response.error
							: new ApiError({
								code	: CLIENT_ERROR.BAD_RESPONSE,
								message	: 'Error: Unable to start page. Check that the server is running and configuration files are correct [1]'
							})
					)
				}

				// environment API data check
				if (!api_response.environment || !api_response.environment.result) {
					// API environment data is not available
					return set_page_error(
						new ApiError({
							code	: CLIENT_ERROR.BAD_RESPONSE,
							message	: 'Error: Unable to start page: environment is unavailable. Check that the server is running and configuration files are correct [2]'
						})
					)
				}
				// fix API environment vars to window (page_globals, plain_vars, get_label)
				set_environment(api_response.environment.result)
				// the user's active-field style (page_globals.ui_preferences). Lazy: off the
				// boot graph (page_load_budget); theme-init.js already painted the cached style
				import('./active_style.js').then(m => m.sync_active_style_from_server())

				// engine-build cache guard. The 'section_cache_*' / 'page_cache_*'
				// IndexedDB entries are otherwise only cleared on logout or language
				// change, so a logged-in browser keeps serving a PREVIOUS engine
				// build's cached API payloads forever (hard reload does not touch
				// IndexedDB). Compare the build stamp the server just sent against
				// the one stored at the last purge and drop both prefixes on any
				// change. Fire-and-forget: the purge only needs to land before the
				// next cacheable request, never blocks the boot paint.
				const current_build = page_globals.dedalo_build || page_globals.dedalo_version || null
				if (current_build) {
					data_manager.get_local_db_data('client_cache_build', 'status')
					.then(async function(stored){
						if (stored?.value !== current_build) {
							await data_manager.delete_local_db_data_by_prefix('data', 'section_cache_')
							await data_manager.delete_local_db_data_by_prefix('data', 'page_cache_')
							data_manager.set_local_db_data(
								{ id: 'client_cache_build', value: current_build },
								'status'
							)
						}
					})
				}

				// ontology master server. Mark the body once the environment is known
				// (page_globals.is_ontology_server, from IS_AN_ONTOLOGY_SERVER — WC-031)
				// so ontology_server.less can skin the whole app. Done HERE, not in
				// set_custom_css(), because init() (and its set_custom_css call) runs
				// before build() populates page_globals. @see page/css/layout/ontology_server.less
				if (page_globals.is_ontology_server===true) {
					document.body.classList.add('is_ontology_server')
				}

				// check environment (var DEDALO_ENVIRONMENT is set from API environment result plain_vars. Expected bool true)
				if (typeof DEDALO_ENVIRONMENT==='undefined') {
					// environment vars are not set correctly
					console.error('!!! STOP build: environment unavailable. DEDALO_ENVIRONMENT var is not defined');

					return set_page_error(
						new ApiError({
							code	: CLIENT_ERROR.BAD_RESPONSE,
							message	: 'Error: The environment is not available. Check that the server is running and configuration files are correct [3]'
						})
					)
				}

				// server_errors check (minor page and environment errors)
				if (api_response.dedalo_last_error) {
					console.error('Page running with server errors. dedalo_last_error: ', api_response.dedalo_last_error);
				}

				// set context and data to current instance
				self.context	= start_data.context
				self.data		= {}
			}
		}//end if (autoload===true)

	// check page context is valid. If not, return special error node
		if (!self.context) {

			// page_error.
			// It's important to set the page error because this generates a
			// temporal wrapper. Once solved the problem, (usually a not login scenario)
			// the instance could be built and rendered again replacing the temporal wrapper
				set_page_error(
					new ApiError({
						code	: CLIENT_ERROR.BAD_RESPONSE,
						message	: 'Invalid context. ' + (page_globals.request_message ?? '')
					})
				)

			return false
		}

	// status update
		self.status = 'built'


	return true
}//end build



/**
* NAVIGATE
* Handles user-initiated navigation events published as `user_navigation`.
* Replaces the active page element (section, area, tool) without reloading
* the full page — the menu and other `base_models` instances are preserved.
*
* Flow:
* 1. Prompts for unsaved data confirmation; aborts navigation on cancel.
* 2. Acquires an in-progress navigation lock to prevent concurrent navigations.
* 3. Adds a `.loading` CSS class to the content area while work is in progress.
* 4. Cancels any active stream readers (e.g. SSE diffusion streams).
* 5. Injects `sqo` into `source.request_config` when an SQO is supplied but no
*    request_config exists, allowing the new section to start with a pre-set filter.
* 6. Calls `instantiate_page_element()` to load/init the new page element instance.
* 7. Prunes `self.context` and `self.ar_instances` to only `base_models` + new source,
*    destroying instances that are no longer needed to free memory and event subscriptions.
* 8. Calls `dd_garbage_collector()` to prune excess CSS injected rules.
* 9. Calls `self.refresh()` to re-render the content area.
* 10. Updates the browser history state via `push_browser_history()` unless the event
*    originated from a browser back/forward button (`event_in_history === true`).
* 11. Releases component locks on the previous section via a background worker request.
*
* This function is private (not exported) and is always invoked with `this` bound to
* the page instance by the `user_navigation` event handler in `init()`.
*
* @param {Object} user_navigation_options - Navigation payload from event_manager
* @param {Object}       user_navigation_options.source             - Context descriptor of the target page element
* @param {string}       user_navigation_options.source.tipo        - Ontology tipo of the element (e.g. 'rsc170')
* @param {string}       user_navigation_options.source.model       - Model name (e.g. 'section', 'menu')
* @param {string}       user_navigation_options.source.mode        - Render mode ('list'|'edit'|…)
* @param {Object|null}  [user_navigation_options.sqo=null]         - Search query object to pre-load
* @param {boolean}      [user_navigation_options.event_in_history] - true when triggered by popstate (back/fwd button)
* @returns {Promise<string|boolean>} Resolves to the new page element instance id on success,
*                                    or false on failure / user cancellation
*/
const navigate = async function(user_navigation_options) {

	const self = this

	// options
		const source			= user_navigation_options.source
		const sqo				= user_navigation_options.sqo || null
		const event_in_history	= user_navigation_options.event_in_history ?? false

	// check_unsaved_data
		const result = await check_unsaved_data({
			confirm_msg : 'page: ' + (get_label.discard_changes || 'Discard unsaved changes?')
		})
		if (!result) {
			// user selects 'cancel' in dialog confirm. Stop navigation
			return false
		}

	// check valid vars
		if (!source) {
			console.error("ERROR. valid source is mandatory on user_navigation:", user_navigation_options);
			return false
		}

	// navigation lock
		if (self.navigation_in_progress) {
			console.warn('Navigation already in progress. Ignored call:', user_navigation_options);
			return false
		}
		self.navigation_in_progress = true

	// page error. A NEW page element is being loaded: the previous element's
	// page-level failure is no longer the page's state. Left set, every render
	// of the next element would be swapped for the old error panel — the page
	// stuck on a refusal it has navigated away from.
		page_globals.page_error = null

	// reset status to prevent errors lock
		self.status = 'rendered'

	// loading css add
		const container = self.node
			? self.node.content_data
			: null
			if (container) { container.classList.add('loading') }

	// stream_readers. If any stream reader is active, stop it
		if (page_globals.stream_readers && page_globals.stream_readers.length) {
			page_globals.stream_readers.forEach((el)=>{
				try {
					el.cancel('abort')
				} catch (e) {
					// reader may already be closed; ignore
				}
			})
			// clear so already-cancelled readers are not re-cancelled on next navigation
			page_globals.stream_readers.length = 0
		}

	// source
		// Only source is mandatory but if sqo is received, is placed in a new request_config
		// to allow sections and components manage properly the offset and limit
		if (!source.request_config && sqo) {
			source.request_config = [{
				api_engine	: 'dedalo',
				type		: 'main',
				sqo			: sqo
			}]
		}

	try {

		// new_page_element_instance. Like 'section'
			const new_page_element_instance = await instantiate_page_element(
				self, // object page instance
				source // object source
			)
			// check valid element. Only checks if new source of page element is actually valid for instantiation
			// (!) Note that this element page is called twice, this time and when page is refreshed (assume is cached..)
			if (!new_page_element_instance) {
				console.error("error on get new_page_element_instance:", new_page_element_instance);
				// loading css remove
				if (container) {setTimeout(()=> container.classList.remove('loading'), 50)}
				console.error("ERROR. on instantiate_page_element. Unable to create a valid page element instance. ", user_navigation_options);
				return false
			}

		// page context elements to stay. Menu and other static elements don't need to be built and rendered every time
			const base_models				= ['menu']
			const context_elements_to_stay	= self.context.filter( item => base_models.includes(item.model) )
			// add current source from options
				context_elements_to_stay.push(source)
			// fix new page clean context
				self.context = context_elements_to_stay

		// instances. Set property 'destroyable' as false for own instances to prevent to be remove on refresh page
			const instances_to_stay		= self.ar_instances.filter(item => base_models.includes(item.model))
			const instances_to_remove	= self.ar_instances.filter(item => !base_models.includes(item.model))

			for (let i = instances_to_stay.length - 1; i >= 0; i--) {
				instances_to_stay[i].destroyable = false
			}

		// destroy instances to remove. (Free memory and events)
			if (instances_to_remove.length > 0) {
				await Promise.all(instances_to_remove.map(async (inst) => {
					if (typeof inst.destroy === 'function') {
						await inst.destroy(true, true, true) // delete_self, delete_dependencies, remove_dom
					}
				}))
			}
			// fix ar_instances to stay
			self.ar_instances = instances_to_stay


		// clean CSS and other garbage
			dd_garbage_collector();

		// refresh page. Force to load new context elements data from DDBB
			const refresh_result = await self.refresh({
				build_autoload	: false,
				render_level	: 'content',
				destroy			: false // Set false to prevent delete self.ar_instances
			})

		// reset page scroll
			window.scrollTo(0, 0);

		// browser history track. Navigating from menu for example
			// If is not already mark as used in history
			if(refresh_result===true && event_in_history!==true) {

				// page tile
					const title	= new_page_element_instance.id

				// page url
					const current_tipo = source.config?.source_section_tipo || source.tipo;
					// record id. The address bar carries the record while one is open:
					// a section deep link WITH an id is the edit view (server `start`
					// forces it), and `id` left in a list would decay into that record's
					// edit page on reload. The navigation's OWN values come first — the
					// element is only init'ed here (its read happens later inside
					// refresh), and a cached instance can still carry the previous
					// record. section.build corrects the entry once the record is read
					// (section.js sync_url_record).
						const section_id = (new_page_element_instance.model==='section' && source.mode!=='list')
							? (source.section_id ?? source.section_id_selected ?? new_page_element_instance.section_id ?? null)
							: null
					// url search.
						const current_url_vars = url_vars_to_object(location.search)
						const url_vars = {} // url_vars_to_object(location.search)
							  url_vars.tipo = current_tipo
							  url_vars.mode = source.mode
						if (section_id!==null) {
							url_vars.id = section_id
						}
						// source.config.url_vars add if they exists
						// used by menu thesaurus_view_mode
						if (source.config?.url_vars) {
							for (const property in source.config.url_vars) {
								url_vars[property] = source.config.url_vars[property]
							}
						}
						// preserve URL vars
						const preserve_url_vars = [
							'menu',
							'session_save'
						]
						preserve_url_vars.forEach(name => {
							if (typeof current_url_vars[name]!=='undefined') {
								url_vars[name] = current_url_vars[name]
							}
						})
						const url = '?' + object_to_url_vars(url_vars)

				// browser navigation update
					push_browser_history({
						source				: source,
						sqo					: sqo,
						event_in_history	: false,
						title				: title,
						url					: url
					})
			}

		// remove aux items
			if (window.page_globals.service_autocomplete) {
				window.page_globals.service_autocomplete.destroy(true, true, true)
			}

		// loading css remove
			if (container) { container.classList.remove('loading') }

		// clean previous locks of current user in current section
			dd_request_idle_callback(
				() => {
					data_manager.request({
						use_worker	: true,
						body		: {
							dd_api			: 'dd_utils_api',
							action			: 'update_lock_components_state',
							prevent_lock	: true,
							options			: {
								component_tipo	: null,
								section_tipo	: source.section_tipo || source.tipo,
								section_id		: null,
								action			: 'delete_user_section_locks' // delete_user_section_locks|blur|focus
							}
						}
					})
					.then(function(api_response){
						// dedalo_notification from config file
						// update page_globals
						page_globals.dedalo_notification = api_response.dedalo_notification || null
						// dedalo_notification from config file
						event_manager.publish('dedalo_notification', page_globals.dedalo_notification)
					})
				}
			)

		return new_page_element_instance.id

	} catch (error) {
		// loading css remove
		if (container) { container.classList.remove('loading') }
		console.error('Error on user navigation. user_navigation_options:', user_navigation_options)
		console.error(error)

		return false
	} finally {
		// unlock navigation
		self.navigation_in_progress = false
	}
}//end navigate



/**
* DESTROY
* Extends common.prototype.destroy to also unregister global window/document
* event listeners that were attached in `add_events()`.
*
* This override is necessary because the page shell attaches listeners directly
* to `window` and `document` (popstate, beforeunload, keydown, mousedown), which
* are not tracked by the standard `events_tokens` mechanism and would otherwise
* leak across re-mounts.
*
* Delegates the remainder of the teardown — instance list pruning, ar_instances
* destruction, event_manager unsubscription — to `common.prototype.destroy`.
*
* @param {boolean} [delete_self=true]         - Remove this instance from the instances registry
* @param {boolean} [delete_dependencies=false] - Also destroy child instances in ar_instances
* @param {boolean} [remove_dom=false]          - Remove self.node from the DOM
* @returns {Promise<*>} Result of common.prototype.destroy
*/
page.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	// stop lock_components timers (heartbeat + any pending notify-on-release poll)
		if (self.lock_heartbeat_interval) {
			clearInterval(self.lock_heartbeat_interval)
			self.lock_heartbeat_interval = null
		}
		if (self.lock_release_poll_interval) {
			clearInterval(self.lock_release_poll_interval)
			self.lock_release_poll_interval = null
		}

	// remove window/document events
		if (self.popstate_handler) {
			window.removeEventListener('popstate', self.popstate_handler)
		}
		if (self.beforeunload_handler) {
			window.removeEventListener('beforeunload', self.beforeunload_handler, {capture: true})
		}
		if (self.keydown_handler) {
			document.removeEventListener('keydown', self.keydown_handler)
		}
		if (self.mousedown_handler) {
			document.removeEventListener('mousedown', self.mousedown_handler)
		}

	// call common destroy
		return common.prototype.destroy.call(this, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* SEND_LOCK_RELEASE_BEACON
* The beforeunload lock release: ONE navigator.sendBeacon of
* `update_lock_components_state` / `delete_user_section_locks` for the section of
* the active component. sendBeacon cannot set headers, so the CSRF token travels
* in the body (the API accepts rqo->csrf_token); text/plain avoids a CORS
* preflight on unload.
*
* THE PAGE-IDENTITY LATCH (LEAD-2): the beacon is a transport of its own, so it
* asks error_dispatch.refused_by_page_identity like every other. The server runs
* `delete_user_section_locks` as the SESSION's user: on a page whose identity was
* revoked (a re-login as B on A's page, then the reload the latch asked for)
* the beacon would release B's live locks in A's section — B editing it in
* another tab. Refused, nothing is sent; A's own lock expires by LOCK_TTL, as
* it must anyway (the session that owns it is gone).
* @param {Object} options
* @param {Object|null} options.component_active - page_globals.component_active
* @param {string|null} options.csrf_token - page_globals.csrf_token
* @param {string} options.api_url
* @param {Function} options.send_beacon - (url, Blob) => boolean
* @return {boolean} true when a beacon was handed to the browser
*/
export const send_lock_release_beacon = function(options) {

	const {component_active, csrf_token, api_url, send_beacon} = options
	if (!component_active || typeof send_beacon!=='function') {
		return false
	}

	const body = {
		dd_api			: 'dd_utils_api',
		action			: 'update_lock_components_state',
		prevent_lock	: true,
		csrf_token		: (csrf_token || null),
		options			: {
			component_tipo	: null,
			section_tipo	: component_active.section_tipo,
			section_id		: null,
			action			: 'delete_user_section_locks'
		}
	}
	if (refused_by_page_identity(body)) {
		return false
	}

	send_beacon(api_url, new Blob([JSON.stringify(body)], {type:'text/plain'}))
	return true
}//end send_lock_release_beacon



/**
* ADD_EVENTS
* Attaches the global window- and document-level event listeners for the page shell.
* Handlers are stored as named properties (e.g. `self.popstate_handler`) so that
* `destroy()` can unregister them precisely without removing unrelated listeners.
*
* Registered listeners:
*   window 'popstate'      — Re-publishes `user_navigation` from browser history state
*                            when the user clicks Back/Forward; marks the event as
*                            `event_in_history: true` so `navigate()` skips pushing a
*                            duplicate history entry.
*   window 'beforeunload'  — Prompts the user before leaving if `window.unsaved_data`
*                            is true (component_text_area and others set this flag).
*                            Uses `event.returnValue = true` to trigger the browser's
*                            built-in "changes may not be saved" dialog (text cannot be
*                            customised in modern browsers).
*   document 'keydown'     — Application-wide keyboard shortcuts:
*                              Escape      → priority ladder: open modal (dd-modal owns it)
*                                            → CSS fullscreen → component that binds ESC
*                                            (text_area AV play/pause) → deactivate the
*                                            active component (saves pending changed_data)
*                              Shift+Left  → paginator previous page
*                              Shift+Right → paginator next page
*                              Ctrl+I      → toggle inspector panel
*                              ⌘K / Ctrl+K → command palette (sections + current
*                                            section tools; common/js/command_palette.js)
*                              Enter       → execute section search or open search panel
*                                            (blocked inside modals and paginator inputs)
*   document 'mousedown'   — Calls `deactivate_components()` to blur the active component
*                            when the user clicks outside it.
*
* @returns {void}
*/
page.prototype.add_events = function() {

	const self = this

	// command palette (⌘K): binds this page for menu + section lookup. Lazy: off the
	// boot graph (page_load_budget); ⌘K is a no-op until the module has arrived
		import('../../common/js/command_palette.js').then(m => {
			m.init_command_palette(self)
			self.command_palette = m
		})

	// window onpopstate. Triggered when user clicks on the browser navigation buttons
		// note that navigation calls generate a history of event state, and when user click's on back button,
		// the browser get this event form history with the state info stored previously
		self.popstate_handler = function(event) {
			if (event.state && event.state.user_navigation_options) {
				// get previously stored state data
				const new_user_navigation_options = event.state.user_navigation_options
				// mark as already used in history
				new_user_navigation_options.event_in_history = true
				// publish the event normally as usual
				event_manager.publish('user_navigation', new_user_navigation_options)
			}
		}
		window.addEventListener('popstate', self.popstate_handler)

	// lock_components heartbeat
		// Periodically refresh the focus lock on the currently active component so a
		// crashed/closed/disconnected browser releases it within LOCK_TTL_SECONDS instead
		// of lingering. Driven by page_globals.component_active, so it follows focus/blur
		// with no extra bookkeeping (no active component → the tick is a no-op).
		// (!) The DEDALO_LOCK_COMPONENTS const is emitted by environment.js, which may not
		// have evaluated yet when add_events() runs at init — reading it synchronously here
		// throws a ReferenceError. So the guard lives INSIDE the (deferred) tick, where the
		// const is always defined; if the feature is off the first tick stops the timer.
		self.lock_heartbeat_interval = setInterval(
			() => {
				if (typeof DEDALO_LOCK_COMPONENTS==='undefined' || DEDALO_LOCK_COMPONENTS!==true) {
					clearInterval(self.lock_heartbeat_interval)
					self.lock_heartbeat_interval = null
					return
				}
				const ca = page_globals.component_active
				if (!ca || !takes_lock(ca)) {
					return
				}
				data_manager.request({
					use_worker	: true,
					body		: {
						dd_api			: 'dd_utils_api',
						action			: 'update_lock_components_state',
						prevent_lock	: true,
						options			: {
							component_tipo	: ca.tipo,
							section_tipo	: ca.section_tipo,
							section_id		: ca.section_id,
							action			: 'focus' // a focus re-send refreshes the lock timestamp
						}
					}
				})
			},
			45000 // 45s, comfortably under the server LOCK_TTL_SECONDS (150s)
		)

	// beforeunload (event)
		self.beforeunload_handler = function(event) {
			// event.preventDefault();

			// best-effort lock release on tab close. The short TTL is the guarantee; this
			// just frees the lock immediately when the browser allows a final beacon.
			// sendBeacon cannot set headers, so the CSRF token travels in the body (the
			// API accepts rqo->csrf_token); text/plain avoids a CORS preflight on unload.
				// typeof-guarded: a window unloaded before `start` delivered the
				// environment (a reload while booting) has no such global yet
				if (typeof DEDALO_LOCK_COMPONENTS!=='undefined' && DEDALO_LOCK_COMPONENTS===true && typeof navigator!=='undefined' && navigator.sendBeacon) {
					try {
						send_lock_release_beacon({
							component_active	: page_globals.component_active,
							csrf_token			: page_globals.csrf_token,
							api_url				: (typeof DEDALO_API_URL!=='undefined') ? DEDALO_API_URL : '../api/v1/json/',
							send_beacon			: (url, data) => navigator.sendBeacon(url, data)
						})
					} catch (e) {
						// ignore: the lock will expire via LOCK_TTL_SECONDS anyway
					}
				}

			// force the focused field to COMMIT before reading the flag. A reload
			// or tab close does not blur the active element, so a view that only
			// commits on the native 'change' event (component_input_text and
			// friends) would never hand its typing to its component instance.
			// blur() fires change synchronously: a genuine edit registers the
			// instance (guard armed, prompt shown) and a typed-then-reverted value
			// deregisters it (no false prompt).
				try {
					const active_element = document.activeElement
					if (active_element && typeof active_element.blur==='function' && active_element!==document.body) {
						active_element.blur()
					}
				} catch (e) {
					// never let the guard throw: the unsaved-typing registry
					// (events.js) already armed the flag on the first keystroke
				}

			const unsaved_data = typeof window.unsaved_data!=='undefined'
				? window.unsaved_data
				: false

			// unsaved_data case
			// Check for unsaved components, usually happens in component_text_area editions because
			// the delay (500 ms) to set as changed
				if (unsaved_data===true) {
					// check_unsaved_data (flush only: the native beforeunload prompt asks)
					check_unsaved_data({flush_only: true})
				}

			// unsaved_data is false. Nothing to worry about
				if (unsaved_data!==true) {
					// removeEventListener('beforeunload', beforeUnloadListener, {capture: true})
					return false
				}

			// set event.returnValue value to force browser standard message (unable to customize)
			// like : 'Changes that you made may not be saved.'
				event.returnValue = true
		}
		window.addEventListener('beforeunload', self.beforeunload_handler, {capture: true})

	// keydown events
		self.keydown_handler = function(evt) {
			switch(evt.key) {

				case 'Escape': {
					// Escape priority ladder. The page owns Escape ONLY as the last
					// step; every narrower scope that legitimately consumes it wins
					// first, so one press dismisses exactly one thing.
					//  1. open modal          → dd-modal closes the topmost (own keyup)
					//  2. CSS fullscreen      → ui.enter_fullscreen exits (own keyup)
					//  3. component owning ESC→ e.g. component_text_area AV play/pause
					//  4. otherwise           → deactivate the active component
					// (Overlays with a narrower scope — suggestion lists, inline edits,
					// the command palette — stopPropagation on their own keydown and
					// never reach here.)

					// 1. modal is open case
					if (window.modal) {
						// Note that dd-modal has is own ESC event to close the modal
						return
					}

					// 2. CSS fullscreen is active (ui.enter_fullscreen exits on keyup)
					if (document.querySelector('.fullscreen')) {
						return
					}

					const component_active = page_globals.component_active

					// 3. the active component binds Escape to its own action
					// (component_text_area AV play/pause: features.av_player.av_play_pause_code)
					const av_player = component_active?.context?.features?.av_player
					if (av_player && av_player.av_play_pause_code==='Escape') {
						return
					}

					// 4. deactivate the user activated component
					// (this saves pending changed_data and publishes 'deactivate_component')
					if (component_active) {
						ui.component.deactivate(component_active)
					}

					// blur active input
					document.activeElement?.blur()
					break;
				}

				case 'ArrowLeft': {
					if (evt.shiftKey) {
						// paginator left arrow <
						const section_prev = self.ar_instances.find(el => el.model==='section')
						if (section_prev && section_prev.paginator) {
							section_prev.paginator.navigate_to_previous_page()
						}
					}
					break;
				}

				case 'ArrowRight': {
					if (evt.shiftKey) {
						// paginator right arrow >
						const section_next = self.ar_instances.find(el => el.model==='section')
						if (section_next && section_next.paginator) {
							section_next.paginator.navigate_to_next_page()
						}
					}
					break;
				}

				case 'k':
				case 'K': {
					if (evt.metaKey || evt.ctrlKey) {
						if (self.command_palette?.open_command_palette()) {
							evt.preventDefault()
						}
					}
					break;
				}

				case 'i': {
					if (evt.ctrlKey) {
						// inspector toggle
						ui.toggle_inspector()
					}
					break;
				}

				case 'Enter': {
					// parent recursive check on document.activeElement
					if (document.activeElement) {
						// find_up_node returns node|null
						const top_node = find_up_node(
							document.activeElement, // DOM node selected
							'DD-MODAL' // only capital letters
						)
						// we are inside modal. Stop actions
						if (top_node) {
							return
						}
						// when the event is fired by paginator stop it
						if(document.activeElement.classList.contains('input_go_to_page')){
							return
						}
					}
					// active component case
					if (page_globals.component_active && page_globals.component_active.mode!=='search') {
						// stop here if a component is active
						return
					}
					// search with current section/area_thesaurus/area_graph/area_ontology filter
					const with_filter_models	= ['section','area_thesaurus','area_graph','area_ontology']
					const with_filter_instance	= self.ar_instances.find(el => with_filter_models.includes(el.model))
					if (with_filter_instance && with_filter_instance.filter && with_filter_instance.mode==='list') {
						if (with_filter_instance.filter.search_panel_is_open===true) {
							// always blur active component to force set dato (!)
							document.activeElement.blur()

							dd_request_idle_callback(
								() => {
									// exec search
									with_filter_instance.filter.exec_search()
								}
							)
						}
						// toggle filter search container
						event_manager.publish('toggle_search_panel_' + with_filter_instance.id)
					}
					break;
				}

				default:

					break;
			}//end switch
		}
		document.addEventListener('keydown', self.keydown_handler)

	// page click/mousedown
		self.mousedown_handler = (e) => {

			deactivate_components(e)
		}
		document.addEventListener('mousedown', self.mousedown_handler)
}//end add_events



/**
* INSTANTIATE_PAGE_ELEMENT
* Loads, configures, and returns a page-element instance (section, menu, tool, area, …)
* using the shared `get_instance()` registry. Does not build or render the instance.
*
* The function extracts all relevant options from `source` — tipo, model, mode, lang,
* config, request_config, view, properties — and translates them into the standard
* `instance_options` object expected by `get_instance()`.
*
* Special cases handled:
*   id_variant  — propagated from the page instance when present, allowing tools
*                 (e.g. tool_transcription) to isolate their child instances.
*   menu model  — forces `id_variant = page_globals.user_id` to prevent id conflicts
*                 when multiple users share a session context.
*   config.source_section_tipo — used by section tools (area_thesaurus, etc.) to set
*                 `id_variant` so the tool instance is keyed to its owning section tipo.
*   url_vars.session_key / session_save — URL params forwarded to the instance for
*                 session-based data pre-loading.
*
* (!) Do not overwrite an existing `instance.caller`; tool instances like
* tool_transcription set their own caller, and overwriting it would break their context.
*
* @param {Object} self   - The page instance (used as caller and for id_variant)
* @param {Object} source - Context descriptor for the element to instantiate
* @param {string}        source.tipo           - Ontology tipo (e.g. 'rsc170')
* @param {string}        [source.section_tipo] - Parent section tipo (defaults to tipo)
* @param {string}        source.model          - Model name ('section' | 'menu' | 'tool' | …)
* @param {string|null}   [source.section_id]   - Section record id (null for list mode)
* @param {string}        source.mode           - Render mode ('list' | 'edit' | …)
* @param {string}        source.lang           - Active language code
* @param {Object|null}   [source.config]       - Tool/area configuration object
* @param {Array|null}    [source.request_config] - Request config descriptors
* @param {string|null}   [source.view]         - Requested render view
* @param {Object|null}   [source.properties]   - Element-level property overrides
* @returns {Promise<Object|null>} The initialised instance, or null if get_instance fails
*/
export const instantiate_page_element = async function(self, source) {

	// short vars
		const tipo				= source.tipo
		const section_tipo		= source.section_tipo || tipo
		const model				= source.model
		const section_id		= source.section_id || null
		const mode				= source.mode
		const lang				= source.lang
		const properties		= source.properties

		const config			= source.config || null // used by tools to config section_tool
		const request_config	= source.request_config
		const view				= source.view

	// instance options
		const instance_options = {
			model			: model,
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			mode			: mode,
			lang			: lang
		}

		// id_variant . Propagate a custom instance id to children
			if (self.id_variant) {
				instance_options.id_variant = self.id_variant
			}

		// menu case. To avoid id conflicts between different users
			if (model==='menu') {
				instance_options.id_variant = page_globals.user_id
			}

		// config. Used by section tools, area_thesaurus model
			if (config) {
				// init adding param config
				instance_options.config	= config
				// section tools id_variant
				if (config.source_section_tipo) {
					instance_options.id_variant	= config.source_section_tipo
				}
			}

		// request_config
			if (request_config) {
				instance_options.request_config = request_config
			}

		// view
			if (view) {
				instance_options.view = view
			}

		// properties
			if (properties) {
				instance_options.properties = properties
			}

		// url_vars session_key
			const url_vars = url_vars_to_object(location.search)
			if (url_vars.session_key) {
				instance_options.session_key = url_vars.session_key
			}
			if (url_vars.session_save) {
				instance_options.session_save = JSON.parse(url_vars.session_save)
			}

	// page_element instance (load file)
		const instance = await get_instance(instance_options)

	// caller. Set element caller. Useful to update menu section label from modal section
	// ! Do not overwrite already existing caller (tool case like tool_transcription)
		if (instance && !instance.caller) {
			instance.caller = self
		}


	return instance
}//end instantiate_page_element



/**
* UPDATE_CSS_FILE
* Forces the browser to reload a `<link>` stylesheet by appending a timestamp
* query-string (`?v=<timestamp>`) to the href, bypassing the browser cache.
*
* Only operates on the first matched stylesheet; subsequent calls on an already-
* versioned URL (href already contains '?') are no-ops to avoid appending multiple
* parameters on repeated calls.
*
* @param {string} sheet_name - Substring to match in the stylesheet href (e.g. 'main')
* @returns {boolean} true when the href was updated; false when not found or already versioned
*/
const update_css_file = function(sheet_name) {

	const style_sheet = document.querySelector('link[href*=' + sheet_name + ']')
	if (style_sheet) {
		const url = style_sheet.href
		if (url.indexOf('?')===-1) {
			// add version and update style_sheet
			const new_url = url + '?v=' + (new Date().valueOf())
			style_sheet.href = new_url
			return true
		}
	}


	return false
}//end update_css_file



/**
* SET_CUSTOM_CSS
* Detects the host operating system via `navigator.userAgent` and adds a
* corresponding class to `document.body` (`os-windows` or `os-macintosh`).
*
* These classes allow `general.less` (and component LESS files) to apply
* OS-specific overrides — for example, Windows needs custom scrollbar widths
* and Macintosh gets thinner native scrollbars.
*
* Early-return pattern: only the first matching OS class is applied.
*
* @returns {void}
*/
const set_custom_css = function () {

	// browser specifics
	{
		const regex = /Windows/gm;
		const found = regex.exec(navigator.userAgent)
		if (found) {
			// add to body @see general.less for affections
			document.body.classList.add('os-windows')
			return
		}
	}
	{
		const regex = /Macintosh/gm;
		const found = regex.exec(navigator.userAgent)
		if (found) {
			// add to body @see general.less for affections
			document.body.classList.add('os-macintosh')
			return
		}
	}
}//end set_custom_css



/**
* SET_DOCUMENT_TITLE
* Updates the browser window / tab title.
* Called by section and area instances to reflect the currently open record or view.
*
* @param {string} title - New window title (e.g. '22 - Oral history - oh1')
* @returns {boolean} always true
*/
page.prototype.set_document_title = function (title) {

	document.title = title

	return true
}//end set_document_title



/**
* DD_GARBAGE_COLLECTOR
* Removes orphaned dynamically injected CSS rules when the runtime rule-set
* exceeds `max_size` (currently 500 entries).
*
* Background: `css.js` injects per-element style rules (colours, widths, …) via
* `CSSStyleSheet.insertRule`. These accumulate across navigations and can cause
* measurable memory pressure.
*
* (!) Only rules whose selector no longer matches any element in the DOM are
* pruned. Wiping the ENTIRE set is NOT safe: a partial (`render_level:'content'`)
* refresh does not re-apply wrapper-level CSS, so nuking visible components'
* rules leaves them unstyled (e.g. mosaic portals losing their grid on Safari).
*
* Runs inside `dd_request_idle_callback` so it does not block the navigation paint.
* Called by `navigate()` after destroying stale instances.
*
* @returns {void}
*/
const dd_garbage_collector = function () {

	dd_request_idle_callback(
		() => {
			const inserted_rules	= get_inserted_rules();
			const max_size			= 500;
			if (inserted_rules.size > max_size) {

				// Remove only the rules whose component is no longer in the DOM.
				// (!) Never strips CSS from components still visible on screen.
				const pruned = prune_orphan_rules();

				if(SHOW_DEBUG===true) {
					console.log('Pruned orphan CSS rules to reduce memory footprint. Removed:', pruned, ' remaining:', inserted_rules.size );
				}
			}
		}
	);
}//end dd_garbage_collector



/**
* DELETE_CACHE
* Removes all page-level local-DB cache entries whose key starts with `page_cache_`.
*
* Subscribed to the `quit` (user logout) and `change_lang` events in `init()`.
* Clearing on language change is essential so that stale translated labels are not
* served from the local cache after the language switch.
*
* @returns {Promise<void>}
*/
page.prototype.delete_cache = async function () {

	// Get all local DB data
	await data_manager.delete_local_db_data_by_prefix('data', 'page_cache_')

	// CONTENT-BEARING STORES GO TOO, ON LOGOUT (P2-3 / CLI-08).
	//
	// `quit` cleared four unrelated keys and three `data` prefixes, and left the
	// transcription partials sitting in the `status` table. Those hold raw ASR
	// output — recognised speech, speaker turns, timecodes: the personal-data and
	// embargoed material a heritage archive exists to protect — retained 14 days
	// and enforced lazily only when the same tool rewrote the same key.
	//
	// On a shared reading-room workstation that means the NEXT user could read a
	// colleague's interview transcript out of DevTools from the login page, or
	// open the tool and be offered `action_resume` on someone else's work. The
	// key now carries the principal (tool_transcription.js::partial_id), which
	// stops the OFFER; this stops the DATA outliving the session at all.
	await data_manager.delete_local_db_data_by_prefix('status', 'transcription_partial_')
}//end delete_cache



// @license-end
