// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



// imports
	import {common,create_source} from '../../common/js/common.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {open_window} from '../../common/js/utils/index.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {render_menu, render_section_label} from './render_menu.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'



/**
* MENU
* Top-level application navigation bar for Dédalo v7.
*
* Manages the persistent horizontal menu that appears at the top of every page.
* Renders the area/section hierarchy tree (desktop), the mobile hamburger icon,
* the current-section label, language selectors, ontology shortcut, and user
* administration access.
*
* Lifecycle follows the standard Dédalo pattern:
*   init → build (loads context+data from server or local cache) → render
*   → refresh (clears cache, re-builds, re-renders) → destroy
*
* The full server response (`datum`) is cached in IndexedDB keyed by language,
* Dédalo version, and user id (see `build_cache_id`). On logout ('quit' event)
* the cache is wiped via `delete_cache`.
*
* Key properties set during init and used across the lifecycle:
*   tipo           - ontology tipo identifying this menu instance (default 'dd85')
*   model          - class name string identifying the menu model
*   datum          - full server response object {context:[], data:[]}
*   context        - context entry matching this instance's model+tipo
*   data           - data entry matching this instance's model+tipo
*   node           - root HTMLElement once rendered; null until render() completes
*   li_nodes       - flat list of rendered <li> menu-item nodes
*   ul_nodes       - flat list of rendered <ul> submenu nodes
*   ar_instances   - child component instances owned by this menu
*   events_tokens  - active event_manager subscription tokens for cleanup
*   caller         - parent instance that created this menu, or null
*
* Main exports: `menu` constructor (prototype-based class).
*/
export const menu = function(){

	this.id
	this.tipo
	this.mode
	this.model
	this.lang

	this.section_lang
	this.datum
	this.context
	this.data
	this.node
	this.li_nodes
	this.ul_nodes
	this.events_tokens
	this.caller

	this.ar_instances
}//end menu



/**
* COMMON FUNCTIONS
* Extend instance with shared prototype methods from common and render modules.
* Individual prototype.x assignments are not doc-blocked here; see the source
* definitions in common.js and render_menu.js for their contracts.
*/
// prototypes assign
	// lifecycle
	menu.prototype.render				= common.prototype.render
	// destroy — render_menu_tree anchors two listeners on `document`, which the
	// generic teardown cannot reach. Signature MIRRORS common.prototype.destroy:
	// an override with fewer parameters silently drops the last one.
	menu.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {
		const self = this
		if (typeof self.release_document_events==='function') {
			try {
				self.release_document_events()
			} catch (error) {
				console.error('[menu] document event release failed:', error)
			}
		}
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}
	// menu.prototype.refresh			= common.prototype.refresh

	// render
	menu.prototype.list					= render_menu.prototype.edit
	menu.prototype.edit					= render_menu.prototype.edit
	menu.prototype.update_section_label	= render_menu.prototype.update_section_label



/**
* INIT
* Initializes the menu instance with a fixed baseline of well-known properties.
* Unlike other Dédalo elements, menu.init() is synchronous and does NOT call
* common.prototype.init() — it mirrors the same guard pattern but seeds only
* the properties the menu requires (no section_tipo, no section_id, etc.).
*
* Subscribes to the global 'quit' event so that IndexedDB cache entries are
* wiped when the user logs out, preventing stale menu data from appearing on
* the next login.
*
* (!) Calling init() a second time on the same instance is detected and logged
* as an error; the call returns false and SHOW_DEBUG triggers an alert().
*
* @param {Object} options - Initialization options bag
* @param {string} [options.tipo='dd85'] - Ontology tipo for this menu, defaults to 'dd85'
* @param {string} options.model - Model class name, e.g. 'menu'
* @param {Object} [options.datum] - Pre-loaded server datum; if provided, build() skips the API call
* @param {Object} [options.context] - Pre-loaded server context entry for this instance
* @param {Object} [options.data] - Pre-loaded server data entry for this instance
* @param {Object|null} [options.caller=null] - Parent instance that owns this menu
* @returns {boolean} true on success, false if the instance was already initialized
*/
menu.prototype.init = function(options) {

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
		self.tipo						= options.tipo || 'dd85'
		self.model						= options.model
		self.node						= null
		self.li_nodes					= []
		self.ul_nodes					= []
		self.ar_instances				= []
		self.mode						= 'edit'
		self.datum						= options.datum
		self.context					= options.context
		self.data						= options.data
		self.events_tokens				= []
		self.caller						= options.caller || null
		self.update_section_label_n_try	= 0

	// quit event
	// Wipe the local cache whenever the user logs out, so that the next
	// login cannot inherit a previous session's cached menu structure.
		const quit_handler = () => {
			self.delete_cache()
		}
		self.events_tokens.push(
			event_manager.subscribe('quit', quit_handler)
		)

	// menu_config_changed event
	// Published by the maintenance widgets that change what the menu shows
	// (config_areas → areas.deny/allow; menu_skip_tipos → DEDALO_ENTITY_MENU_SKIP_TIPOS_CUSTOM).
	// Rebuild the menu in place (build_autoload deletes the IndexedDB cache and re-fetches),
	// so an admin sees the effect immediately without a logout/reload. The server reads the
	// config fresh on every request, so the rebuilt menu reflects the just-saved change.
		const config_changed_handler = () => {
			self.refresh({ build_autoload: true })
		}
		self.events_tokens.push(
			event_manager.subscribe('menu_config_changed', config_changed_handler)
		)

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Loads context and data for the menu from the server (or IndexedDB cache) and
* sets `self.context` and `self.data` to the entries matching `self.model` and
* `self.tipo`.
*
* When `autoload` is true (the default), an API 'read' request with action
* 'get_data' is issued. The response is stored in IndexedDB under the key
* produced by `build_cache_id()` so that subsequent builds in the same session
* (e.g. after soft navigation) avoid a network round-trip.
*
* When `autoload` is false, `self.datum` must already be populated (e.g. passed
* via `options.datum` during init) — the API call is skipped entirely.
*
* The request uses `prevent_lock: true` because the menu must be available even
* while other sections are loading.
*
* @param {boolean} [autoload=true] - Whether to fetch datum from the server
* @returns {Promise<boolean>} true on success; false on missing datum or bad API response
*/
menu.prototype.build = async function(autoload=true) {
	const t0 = (SHOW_DEBUG === true) ? performance.now() : null

	const self = this

	// status update
		self.status = 'building'

	// autoload
		if (autoload===true) {

			// rqo build
				const rqo = {
					action		: 'read',
					source		: create_source(self, 'get_data'),
					prevent_lock: true
				}

			// cache_handler. Cache API menu data by lang
				const cache_handler = {
					handler	: 'localdb',
					id		: self.build_cache_id()
				}

			// load data. get context and data
				const api_response = await data_manager.request({
					body			: rqo,
					cache_handler	: cache_handler
				})

				// server: wrong response
				if (!api_response) {
					return false
				}
				// server: bad build context
				const datum = response_data(api_response)
				if(!datum?.context?.length){
					console.error("Error!!!!, menu without context:", api_response);
					return false
				}

			// set the result to the datum
				self.datum = datum
		}

	// Safety check for datum before proceeding
		if (!self.datum || !self.datum.context || !self.datum.data) {
			console.warn("Build aborted: datum not available for", self.model);
			return false;
		}

	// set context and data to current instance
	// Locate the entries whose model AND tipo match this instance within the
	// flat context/data arrays returned by the server.
		self.context	= self.datum.context.find(element => element.model===self.model && element.tipo===self.tipo);
		self.data		= self.datum.data.find(element => element.model===self.model &&  element.tipo===self.tipo)

	// debug
		if(SHOW_DEBUG===true) {
			console.log(`__Time to build ${self.model} [autoload:${autoload}] ms:`, performance.now()-t0);
		}

	// status update
		self.status = 'built'


	return true
}//end build



/**
* REFRESH
* Deletes the local menu database and call common refresh
*
* Extends the generic `common.prototype.refresh` by first invalidating the
* IndexedDB cache entry so that the subsequent build always fetches fresh
* data from the server. Pass `build_autoload: false` to skip cache deletion
* (e.g. when refreshing without a new server round-trip is desired).
*
* @param {Object} [options={}] - Refresh options forwarded to common.prototype.refresh
* @param {boolean} [options.build_autoload=true] - When true, deletes local cache before rebuilding
* @returns {Promise<boolean>} Result from common.prototype.refresh
*/
menu.prototype.refresh = async function(options={}) {

	const self = this

	// options
		const build_autoload = options.build_autoload ?? true

	// delete local DB data to force re-create the menu
		if (build_autoload===true) {
			await self.delete_cache()
		}

	// call the generic common refresh
		const common_init = await common.prototype.refresh.call(this, options);


	return common_init
}//end refresh



/**
* OPEN_ONTOLOGY
* Shared function to manage open Ontology window
* from regular menu and mobile menu
*
* Opens the v5 ontology editor in a new browser tab using the configured
* `DEDALO_CORE_URL` global. Called by click handlers in both the desktop
* menu bar and the mobile overlay menu.
*
* @param {Event} e - DOM event; `stopPropagation` is called to prevent bubbling
* @returns {void}
*/
menu.prototype.open_ontology = function(e) {
	e.stopPropagation()

	open_window({
		url			: DEDALO_CORE_URL + '/ontology/v5/',
		target		: '_blank',
		features	: 'new_tab'
	})
}//end open_ontology



/**
* DELETE_CACHE
* Removes all menu local cache data.
* It is fired when login 'quit' event is published (subscription in menu init).
*
* Deletes every IndexedDB entry in the 'data' table whose key starts with
* 'menu_cache_', covering all language/version/user variants that may have
* been written during the session. Uses a prefix range delete rather than
* enumerating individual keys, so new variants created in future do not
* require changes here.
*
* @returns {Promise<void>}
*/
menu.prototype.delete_cache = async function() {
	// Delete menus in all langs
	await data_manager.delete_local_db_data_by_prefix('data', 'menu_cache_')
}//end delete_cache



/**
* OPEN_TOOL_USER_ADMIN_HANDLER
* Shared function to manage open tool tool_user_admin
*
* Looks up the 'tool_user_admin' entry in `self.context.tools` and opens
* it via the standard `open_tool` helper (which handles window management,
* positioning, and tool lifecycle). Logs a console error and returns early
* if the tool is not available in the current user's profile, which is
* expected for users without administrator rights.
*
* @returns {void}
*/
menu.prototype.open_tool_user_admin_handler = function() {

	const self = this

	// tool_user_admin Get the user_admin tool to be fired
		const tool_user_admin = self.context.tools.find(el => el.model==='tool_user_admin')
		if (!tool_user_admin) {
			console.error('Tool user admin is not available in tools. Check your user profile tools:', self.context.tools);
			return
		}

	// open_tool (tool_common)
		open_tool({
			tool_context	: tool_user_admin,
			caller			: self
		})
}//end open_tool_user_admin_handler



/**
* BUILD_CACHE_ID
* Unifies function to build the id of the stored local DB value
* It used one for each language as menu_dd85_lg-nep
*
* Builds an IndexedDB storage key that uniquely identifies a cached menu
* response for a given language, Dédalo version, and logged-in user. Using
* all three factors prevents stale cache hits after upgrades or user switches.
*
* Key format: `menu_cache_<lang>_<version>_<userId>`
* Example:    `menu_cache_lg-spa_7.0.3_42`
*
* Falls back gracefully when `page_globals` or any sub-property is absent
* (e.g. during early page load) by using empty strings.
*
* @param {string} [lang] - Language tag (e.g. 'lg-spa'). Defaults to
*   `page_globals.dedalo_application_lang` when omitted.
* @returns {string} The IndexedDB cache key for this menu's response
*/
menu.prototype.build_cache_id = function(lang) {

	// globals safety
	const globals = window.page_globals || {}

	// user id. Logged user id
	const user_id = globals.user_id || ''

	// lang cascade fallback
	lang = lang || globals.dedalo_application_lang || ''

	const version = globals.dedalo_version || 'unknown'

	// id composition
	const id = `menu_cache_${lang}_${version}_${user_id}`


	return id
}//end build_cache_id



/**
* UPDATE_SECTION_LABEL
* Change the menu section label value
* Is called from section when rendering is finished
*
* Updates the section-label slot in the already-rendered menu DOM with the
* label text of the currently active section. Because this is called by the
* section after it finishes rendering, the menu node may not yet be in the
* DOM. A retry mechanism (max 3 attempts, 1 s apart) accommodates race
* conditions during initial page load.
*
* In 'edit' mode the new label becomes clickable (activates the section
* inspector) and the "toggle inspector" button is shown. In other modes
* (e.g. 'list', 'search') the label is inert and the inspector button is
* hidden to avoid confusion.
*
* The method replaces the existing `.section_label` node in-place and
* re-registers the click handler on the new node. The `self.node.content_data`
* pointer is updated so subsequent calls target the new node.
*
* @param {Object} options - Update options
* @param {string} [options.value=''] - HTML string to inject as the label text
* @param {string} options.mode - Current render mode: 'edit' or other (e.g. 'list')
* @param {Function} [options.section_label_on_click] - Mousedown handler attached
*   to the new label node when mode is 'edit'; toggles the section inspector panel
* @returns {boolean|undefined} true on success; false if the node or label element
*   is unavailable; undefined after scheduling a retry
*/
menu.prototype.update_section_label = function(options) {

	const self = this

	// options
		const value						= options.value || ''
		const mode						= options.mode
		const section_label_on_click	= options.section_label_on_click

	// check availability
	// Guard against calling this before the menu has been rendered. Retries
	// up to 3 times at 1-second intervals before giving up with a warning.
		const update_section_label_n_try = self.update_section_label_n_try ?? 0
		if (!self.node) {
			if (update_section_label_n_try>=3) {
				console.warn('Error: menu node is not available.', self);
				return
			}
			self.update_section_label_n_try++
			console.warn('Warning: menu node is not available yet. Trying again ', update_section_label_n_try);
			setTimeout(function(){
				self.update_section_label(options)
			}, 1000)
			return false
		}
		if (!self.node.content_data.section_label) {
			console.warn('Warning: Invalid menu node section_label.', self.node.content_data.section_label);
			return false
		}

	// reset self.update_section_label_n_try
		self.update_section_label_n_try = 0

	// pointers get
		const section_label				= self.node.content_data.section_label
		const button_toggle_inspector	= self.node.content_data.button_toggle_inspector

	// new_section_label
	// Build a fresh DOM node, inject the label HTML, then swap it with the
	// existing node. Re-point the content_data reference so future updates
	// always act on the current node.
		const new_section_label = render_section_label(self)
		new_section_label.insertAdjacentHTML('afterbegin', value);
		section_label.replaceWith(new_section_label);
		// re-set pointers
		self.node.content_data.section_label = new_section_label

	// toggle inspector view
	// In edit mode, the section label is a clickable affordance for the
	// inspector panel and the inspector toggle button is visible. In other
	// modes both are suppressed so read-only views remain uncluttered.
		if (mode==='edit') {
			if (typeof section_label_on_click==='function') {
				new_section_label.addEventListener('mousedown', section_label_on_click)
			}
			// hide button inspector
			button_toggle_inspector.classList.remove('no_visible')
			// enable section_label user click
			new_section_label.classList.remove('inactive')
		}else{
			// show button inspector
			button_toggle_inspector.classList.add('no_visible')
			// disable section_label user click
			new_section_label.classList.add('inactive')
		}


	return true
}//end update_section_label



/**
* CHANGE_LANG
* Exec API request of selected lang (e.target.value)
*
* Sends a 'change_lang' action to the server via the `dd_utils_api` endpoint,
* persisting the user's language preference for either the interface language
* or the data content language. After the server confirms the change, the
* 'change_lang' event is published so that open sections can invalidate their
* own caches and reload with the new language — only when the server stored the
* change (a refusal, ok:false, publishes nothing: no cache is stale).
*
* The request is routed through a web worker (`use_worker: true`) to keep the
* main thread responsive during the network call.
*
* @param {Object} options - Language-change options
* @param {string} options.lang_type - The lang preference key to update, e.g.
*   'dedalo_data_lang' (content language) or 'dedalo_application_lang' (UI language)
* @param {string} options.lang_value - The new language tag, e.g. 'lg-spa'
* @returns {Promise<Object>} API response object from the server
*/
menu.prototype.change_lang = async function(options) {

	// options
		const lang_type		= options.lang_type
		const lang_value	= options.lang_value

	// api call
		const api_response = await data_manager.request({
			use_worker	: true,
			body		: {
				action	: 'change_lang',
				dd_api	: 'dd_utils_api',
				options	: {
					[lang_type] : lang_value
				}
			}
		})

	// change_lang
	// section is looking for this event to delete cache — published ONLY when the
	// server STORED the change (T2 chain review): a refused change leaves every
	// cache valid, so it must not make sections drop and reload them.
	if (!request_failed(api_response)) {
		event_manager.publish('change_lang', lang_value)
	}


	return api_response
}//end change_lang



// @license-end
