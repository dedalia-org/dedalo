// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_TOOLS_URL */
/*eslint no-undef: "error"*/



/**
* SECTION
* Core client-side class that orchestrates a Dédalo section (a structured record set).
*
* A section is the fundamental container of records in the Dédalo data model.  Each
* section instance wraps one ontology tipo (e.g. 'oh1' for an "Oral History" section)
* and can render in several modes:
*
*   edit    — single-record edit form, one record visible at a time
*   list    — paginated table/grid of records
*   tm      — Translation Memory view (also uses the list render path)
*   solved  — read-only solved/published view of a record
*
* Lifecycle (mirrors all Dédalo UI elements):
*   init → build([autoload]) → render() → refresh() cycles → destroy()
*
* Key responsibilities:
*   - Maintains the Search Query Object (SQO) inside `self.rqo` that drives every
*     API call for context, data, count, create, duplicate, and delete.
*   - Owns a `filter` (search instance), `paginator`, and `inspector` sub-instance.
*   - Subscribes to namespaced event_manager events during init so that buttons,
*     menus, and the thesaurus area can trigger section operations without tight coupling.
*   - Persists pagination state to the local IndexedDB (data_manager.set/get_local_db_data)
*     so that navigating away and back restores the user's position.
*   - Propagates record-count caching via `get_total` with promise-based deduplication
*     to avoid redundant API round-trips.
*
* Main exports:
*   section              — constructor (assign to prototypes via `new section()`)
*   get_section_records  — factory that builds an array of section_record instances
*                          for the current page of entries
*
* Related modules:
*   render_edit_section, render_list_section, render_solved_section,
*   render_common_section — mode-specific render implementations
*   common.js             — shared lifecycle prototype methods
*   instances.js          — instance registry / get_instance factory
*   data_manager.js       — API request layer + local DB persistence
*   event_manager.js      — pub/sub bus that decouples UI events
*   paginator.js          — pagination sub-instance
*   inspector.js          — record inspector sub-instance
*/

// imports
	import {clone, url_vars_to_object, object_to_url_vars, dd_console, load_style, tool_base_url} from '../../common/js/utils/index.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {get_instance, get_all_instances} from '../../common/js/instances.js'
	import {
		common,
		set_context_vars,
		create_source,
		load_data_debug,
		get_columns_map,
		push_browser_history,
		build_autoload
	} from '../../common/js/common.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {check_unsaved_data} from '../../component_common/js/component_common.js'
	import {is_time_machine_view} from '../../component_common/js/events_subscription.js'
	import {paginator} from '../../paginator/js/paginator.js'
	import {create_row_window} from '../../common/js/row_window.js'
	import {toggle_search_panel} from '../../search/js/render_search.js'
	import {is_own_record_pin} from '../../search/js/search_utils.js'
	import {inspector} from '../../inspector/js/inspector.js'
	import {render_edit_section} from './render_edit_section.js'
	import {render_list_section} from './render_list_section.js'
	import {render_solved_section} from './render_solved_section.js'
	import {render_common_section} from './render_common_section.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'
	import {handle_api_error, handle_api_notice} from '../../common/js/error_dispatch.js'



/**
* IS_PINNED_RECORD_VIEW
* True when this instance's read selects its record with a PIN — exactly one
* locator in `sqo.filter_by_locators` — instead of being a PAGE VIEW selected by
* limit/offset.
*
* The question is about the SELECTOR, not about identity: whatever named the
* record (a URL id, a task record, a freshly created record, a mini-record pen
* that only carries the pin in its sqo) the read is a record view from the
* start, even before `self.section_id` is known. Whether the pin names THIS
* record is `is_own_record_pin`, asked only where a pin may be DROPPED
* (goto_list, the open-relations dialog).
*
* ONE SELECTOR PER READ — the two are exclusive. Sent beside the single pin, an
* offset > 0 skips the only pinned row: the edit form comes up empty (verified
* against the suite database), and a deep offset makes the server walk rows it
* will discard. The rule is enforced where pagination is read, written and
* exited: build() and goto_list().
*
* A pin list of TWO OR MORE locators is a result set (a semantic/RAG search
* resolves its ranked hits into filter_by_locators) and is a page view.
*
* @param {Object} self - section instance
* @returns {boolean}
*/
const is_pinned_record_view = function(self) {

	const pins = self.rqo?.sqo?.filter_by_locators

	return Array.isArray(pins)
		&& pins.length===1
		&& pins[0]?.section_id!==undefined
		&& pins[0]?.section_id!==null
}//end is_pinned_record_view



/**
* SYNC_URL_RECORD
* Make the current history entry name the record the page's own section is
* showing (`?tipo=…&mode=edit&id=…`).
*
* page.navigate() pushes the entry as soon as the navigation is accepted, which
* can be BEFORE the new section has read its record (render is asynchronous), so
* the pushed URL may not know the id yet. This is the correction, and it also
* covers every caller that navigates without naming the record (a mini record
* button, a dashboard card) and a legacy `?tipo=X&mode=edit` bookmark.
*
* replaceState, never push: it rewrites the entry the user is on (the history
* state with source + sqo is kept, so back/forward still restore the view).
* Only the page's own section owns the address bar — a section inside a portal
* or a tool must not rewrite it.
*
* @param {Object} self - section instance
* @returns {void}
*/
const sync_url_record = function(self) {

	if (self.caller?.model!=='page') {
		return
	}

	// the record this view names, or null when it names none (list mode)
	const section_id = (self.mode==='edit' && self.section_id!==null && self.section_id!==undefined)
		? self.section_id
		: null

	const url_vars = url_vars_to_object(location.search)
	const url_has_id = url_vars.id!==undefined && url_vars.id!==null && url_vars.id!==''

	if (section_id===null) {
		// a list must not keep a stale record id (an edit → list mode switch)
		if (!url_has_id) {
			return
		}
		// absence on the wire, without the delete operator
		const { id: _stale_id, ...vars_without_id } = url_vars
		history.replaceState(history.state, '', '?' + object_to_url_vars(vars_without_id))
		return
	}

	if (String(url_vars.id)===String(section_id)) {
		return
	}
	url_vars.id = section_id
	history.replaceState(history.state, '', '?' + object_to_url_vars(url_vars))
}//end sync_url_record



/**
* SECTION
* Constructor that establishes the canonical property baseline for every section
* instance.  All properties are initialised to null so that downstream lifecycle
* methods (build, render) can rely on their existence without `hasOwnProperty`
* guards.
*
* Properties are deliberately not documented as `@var` annotations on the
* constructor lines — the semantics are captured in the init() doc-block and in
* the per-method doc-blocks that set or consume each property.
*
* Usage: section instances are never created with `new section()` directly;
* instead, callers go through `get_instance({ model: 'section', … })` in
* instances.js, which manages the shared instance registry.
*/
export const section = function() {

	this.id						= null

	// element properties declare
	this.model					= null
	this.type					= null
	this.tipo					= null
	this.section_tipo			= null
	this.section_id				= null
	this.section_id_selected	= null
	this.mode					= null
	this.lang					= null
	this.column_id				= null

	this.datum					= null
	this.context				= null
	this.data					= null
	this.total					= null

	this.ar_section_id			= null

	this.node					= null
	this.events_tokens			= null
	this.ar_instances			= null
	this.caller					= null

	this.status					= null

	this.filter					= null
	this.inspector				= null
	this.paginator				= null
	this.buttons				= null

	this.id_variant				= null

	this.request_config_object	= null
	this.rqo					= null

	this.config					= null
	this.fixed_columns_map		= null
}//end section



/**
* COMMON FUNCTIONS
* Extend section with shared prototype methods from common and mode-specific render modules.
* Individual prototype assignments are not separately doc-blocked; see the source
* definitions in common.js, render_edit_section.js, render_list_section.js, etc.
*/
// prototypes assign
	// life cycle
	// section.prototype.render			= common.prototype.render
	// destroy — the graph view anchors a window listener holding a live d3 force
	// simulation, which the generic teardown cannot reach. Signature MIRRORS
	// common.prototype.destroy: an override with fewer parameters silently drops
	// the last one.
	section.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {
		const self = this
		// the row window (window_section_rows) holds the list's viewport observer;
		// its rows are dependencies, so any teardown that reaches them stops it
		if (self.row_window && (delete_self || delete_dependencies)) {
			self.row_window.destroy()
		}
		if (typeof self.release_graph==='function') {
			try {
				self.release_graph()
			} catch (error) {
				console.error('[section] graph release failed:', error)
			}
		}
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}
	section.prototype.refresh			= common.prototype.refresh
	section.prototype.build_rqo_show	= common.prototype.build_rqo_show
	section.prototype.build_rqo_search	= common.prototype.build_rqo_search

	// render
	section.prototype.edit				= render_edit_section.edit
	section.prototype.list				= render_list_section.list
	section.prototype.list_portal		= render_list_section.list
	section.prototype.activity			= render_list_section.list
	section.prototype.list_header		= render_list_section.list_header
	section.prototype.solved			= render_solved_section.solved

	section.prototype.render_delete_record_dialog = render_common_section.render_delete_record_dialog



/**
* INIT
* Seeds all instance properties from `options` and subscribes to the namespaced
* event_manager channels this section owns for its entire lifetime.
*
* This method is called once per instance immediately after construction via
* `get_instance`. A second call on the same instance is treated as a programming
* error (likely a duplicated event subscription) and returns false after logging.
*
* Event subscriptions registered here:
*   new_section_<id>         — creates a blank record and navigates to it
*   duplicate_section_<id>   — duplicates the given record and navigates to the copy
*   delete_section_<id>      — opens the delete confirmation dialog
*   toggle_search_panel_<id> — lazily builds and shows/hides the filter panel
*   render_<id>              — post-render hook (menu label, search panel state restore)
*   quit                     — clears all local section caches on logout
*   change_lang              — clears caches when the active language changes
*
* All of the above events are namespaced by `self.id` to prevent cross-instance
* interference when multiple sections coexist on the same page.
*
* `self.render_views` is also populated here as a static default list that tools
* and portals may extend dynamically before build/render.
*
* @param {Object} options - Options bag, typically forwarded from `get_instance`
* @param {string} options.model - e.g. 'section'
* @param {string} options.tipo - Ontology tipo of this section, e.g. 'oh1'
* @param {string} options.section_tipo - Parent section tipo (often equals options.tipo
*   for top-level sections)
* @param {string|number|null} [options.section_id] - Record identifier; null in list mode
* @param {string|number|null} [options.section_id_selected] - Pre-selected record id
* @param {string} options.mode - Render mode; validated through validate_mode()
* @param {string} options.lang - Active language tag, e.g. 'lg-eng'
* @param {string} [options.section_lang] - Language used for section-level data
* @param {Object|null} [options.parent] - Parent DOM element or instance
* @param {Object|null} [options.caller=null] - Owning page/area/portal instance
* @param {Object|null} [options.datum=null] - Pre-fetched datum (skips build API call)
* @param {Object|null} [options.context=null] - Pre-fetched server context
* @param {Object|null} [options.data=null] - Pre-fetched data entries
* @param {Object|null|boolean} [options.filter=null] - Search filter instance, false to
*   disable entirely (used when a section is embedded without its own filter)
* @param {Object|null|boolean} [options.inspector=null] - Inspector instance or false
* @param {Object|null|boolean} [options.paginator=null] - Paginator instance or false
* @param {Object|null} [options.permissions=null] - Permission flags for the current user
* @param {Array} [options.columns_map=[]] - Column layout map for list views
* @param {Object|null} [options.config=null] - Extended configuration (section_tool, etc.)
* @param {Array|null} [options.request_config=null] - Array of request_config objects that
*   control how the section fetches context and data
* @param {boolean|Object} [options.add_show=false] - Extra show configuration appended
*   to the rqo
* @param {boolean} [options.buttons=true] - Whether action buttons are shown in list views
* @param {boolean} [options.session_save=true] - Persist SQO/pagination to local DB
* @param {string} [options.session_key] - Override the default local-DB key (defaults to
*   tipo via build_sqo_id)
* @param {string|null} [options.view=null] - View variant, e.g. 'default', 'graph'
* @returns {Promise<boolean>} true when initialised; false on duplicate-init guard
*/
section.prototype.init = async function(options) {

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

	// vars
		// instance key used vars
		self.model					= options.model
		self.tipo					= options.tipo
		self.section_tipo			= options.section_tipo
		self.section_id				= options.section_id
		self.section_id_selected	= options.section_id_selected

		// mode. Check for valid mode. If is not valid, use default 'list'
		self.mode					= validate_mode(options.mode)

		self.lang					= options.lang

		// DOM
		self.node					= null

		self.section_lang			= options.section_lang
		self.parent					= options.parent

		self.events_tokens			= []
		self.ar_instances			= []

		self.caller					= options.caller	|| null

		self.datum					= options.datum		|| null
		self.context				= options.context	|| null
		self.data					= options.data		|| null

		self.type					= 'section'
		self.label					= null

		// filter. Allow false as value when no filter is required
		self.filter					= options.filter!==undefined ? options.filter : null

		// inspector. Allow false as value when no inspector is required (notes cases)
		self.inspector				= options.inspector!==undefined ? options.inspector : null

		// paginator. Allow false as value when no paginator is required
		self.paginator				= options.paginator!==undefined ? options.paginator : null

		self.permissions			= options.permissions || null

		// columns_map
		self.columns_map			= options.columns_map || []

		// config
		self.config					= options.config || null

		// request_config
		self.request_config			= options.request_config || null

		// add_show to rqo to configure specific show
		self.add_show 				= options.add_show ?? false

		// buttons. bool to show / hide the buttons in list
		self.buttons 				= options.buttons ?? true

		// session_key
		self.session_save			= options.session_save ?? true
		self.session_key			= options.session_key ?? build_sqo_id(self.tipo)

		// view
		self.view					= options.view ?? null

	// event subscriptions

		// new_section_ event
			const new_section_handler = async () => {

				// lock new section creation while a creation process is working
				// (!) The lock is taken BEFORE the dialog opens, not after it.
				// ui.confirm() suspends this handler while the modal is on screen, so a
				// check-then-set placed after the await is NOT atomic: two rapid clicks
				// would open two dialogs, both would read creating_section===false on
				// resolve, and two records would be created. Read and write with no
				// await between them and the check-and-set is a single synchronous step.
					if (page_globals.creating_section===true) {
						console.error('Error. Ignored new section event. Wait for the creation of the active section to finish.');
						return
					}
					page_globals.creating_section = true

				// created. Decides how the lock is released in the finally block below
					let created = false

				try {
					const label = self.label || self.section_tipo

					const confirmed = await ui.confirm({
						header			: (get_label.new || 'New') + ' ' + (get_label.record || 'record'),
						note			: label,
						body			: get_label.sure || 'Are you sure?',
						accept_class	: 'brand new'
					})
					if (confirmed!==true) {
						return false
					}

					const new_section_id = await self.create_section()

					// navigate to the new record
					if (new_section_id) {
						created = true
						await self.navigate_to_new_section(new_section_id)
					}
				} catch (error) {
					console.error('Error in new_section_handler:', error);
				} finally {
					if (created===true) {
						// unlock new section creation. Set a timeout to prevent accidental double clicks
						setTimeout(function(){
							page_globals.creating_section = false
						}, 1500)
					}else{
						// (!) Cancelled or failed: release NOW, not in 1500 ms. A deferred
						// release on the cancel path would fire while a later, legitimate
						// creation already owns the lock and would clear it under it.
						page_globals.creating_section = false
					}
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('new_section_' + self.id, new_section_handler)
			)

			if(SHOW_DEBUG===true) {
				console.warn('))))) added section event subscription new_section_:', self.id, self.status, performance.now());
			}

		// duplicate_section_ event
			const duplicate_section_handler = async (options) => {

				// options
				const section_id = options.section_id

				// lock new section creation while a creation process is working
				// (!) Taken BEFORE the dialog. See new_section_handler above.
					if (page_globals.creating_section===true) {
						console.error('Error. Ignored duplicate section event. Wait for the creation of the active section to finish.');
						return
					}
					page_globals.creating_section = true

				// created. Decides how the lock is released in the finally block below
					let created = false

				try {
					const label = self.label || self.section_tipo

					const confirmed = await ui.confirm({
						header			: (get_label.duplicate || 'Duplicate') + ` ID: ${section_id}`,
						note			: label,
						body			: get_label.sure || 'Are you sure?',
						accept_class	: 'brand duplicate'
					})
					if (confirmed!==true) {
						return false
					}

					const new_section_id = await self.duplicate_section(section_id)

					// navigate to the new record
					if (new_section_id) {
						created = true
						await self.navigate_to_new_section(new_section_id)
					}
				} catch (error) {
					console.error('Error in duplicate_section_handler:', error);
				} finally {
					if (created===true) {
						// unlock new section creation. Set a timeout to prevent accidental double clicks
						setTimeout(function(){
							page_globals.creating_section = false
						}, 1500)
					}else{
						// Cancelled or failed: release immediately (see new_section_handler).
						page_globals.creating_section = false
					}
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('duplicate_section_' + self.id, duplicate_section_handler)
			)

		// delete_section_ event. (!) Moved to self button delete in render_section_list
			const delete_section_handler = async (options) => {

				// options
					const section_id	= options.section_id
					const section_tipo	= options.section_tipo
					const section		= options.caller
					// Build a minimal one-record SQO if the caller did not provide its own.
					// This prevents the delete dialog from accidentally targeting more records
					// than the user selected.
					const sqo			= options.sqo ||
						{
							section_tipo		: [section_tipo],
							filter_by_locators	: [{
								section_tipo	: section_tipo,
								section_id		: section_id
							}],
							limit				: 1
						}

				// delete_section
					await self.render_delete_record_dialog({
						section			: section,
						section_id		: section_id,
						section_tipo	: section_tipo,
						sqo				: sqo
					})
			}
			self.events_tokens.push(
				event_manager.subscribe('delete_section_' + self.id, delete_section_handler)
			)

		// toggle_search_panel event. Triggered by button 'search' placed into section inspector buttons
			const toggle_search_panel_handler = async () => {
				if (!self.search_container || !self.filter) {

					return
				}
				if (self.search_container.children.length===0) {
					// await add_to_container(self.search_container, self.filter)
					await ui.load_item_with_spinner({
						container	: self.search_container,
						label		: 'filter',
						callback	: async () => {
							await self.filter.build()
							return self.filter.render()
						}
					})
				}
				toggle_search_panel(self.filter)
			}
			self.events_tokens.push(
				event_manager.subscribe('toggle_search_panel_'+self.id, toggle_search_panel_handler)
			)

		// render_ event
			const render_handler = () => {
				// menu label control
					const update_menu = (menu, section_label) => {

						// menu instance check. Get from caller page
						if (!menu) {
							if(SHOW_DEBUG===true) {
								console.log('menu is not available from section.');
							}
							return
						}

						const section_label_click_handler = (e) => {
							e.stopPropagation();
							// goto_list
							return self.goto_list();
						}

						// update_section_label. Show icon Inspector and activate the link event
						menu.update_section_label({
							value					: section_label,
							mode					: self.mode,
							section_label_on_click	: section_label_click_handler
						})
					}//end update_menu

				// call menu label only for direct page created sections
					if ( self.caller?.model==='page' ) {
						dd_request_idle_callback( () => {
							// Resolve the label of the section
							// if the section is called by a section_tool as 'oh81', get his label (transcription, indexation, etc. )
							// it's stored into the tool_context of the config.
							// else get the section label
							const section_label = self.config?.tool_context?.label
								? self.config.tool_context.label
								: self.label

							// set the window document.title
							const page_title = ( self.mode === 'edit' )
								? `${self.section_id} - ${section_label} - ${self.tipo}`
								: `${get_label.list || 'List'} - ${section_label} - ${self.tipo}`

							self.caller.set_document_title(page_title)

							// menu. Get instance from caller page
							const menu_instance = self.caller.ar_instances.find(el => el.model==='menu')
							if (menu_instance) {
								update_menu( menu_instance, section_label )
							}
						})
					}

				// search control
					if (self.search_container && self.filter) {
						dd_request_idle_callback( () => {
							// open_search_panel. local DDBB table status
							// Restores the search panel open/closed state the user left it in.
							// The key schema is: 'open_search_panel_<tipo>_<mode>'
							const status_id		= `open_search_panel_${self.tipo}_${self.mode}`
							const status_table	= 'status'
							data_manager.get_local_db_data(status_id, status_table, true)
							.then(async function(ui_status){
								// (!) Note that ui_status only exists when element is open
								const is_open = typeof ui_status==='undefined' || ui_status.value===false
									? false
									: true
								if (is_open===true && self.search_container && self.search_container.children.length===0) {
									// add_to_container(self.search_container, self.filter)
									await ui.load_item_with_spinner({
										container	: self.search_container,
										label		: 'filter',
										callback	: async () => {
											await self.filter.build()
											const node = await self.filter.render()
											// display hidden search_global_container
											self.filter.search_global_container.classList.remove('hide')
											return node
										}
									})
								}
							})
						})
					}

				// debug
				if(SHOW_DEBUG===true) {
					console.log('section. event_manager.events.length:', event_manager.get_events().length);
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('render_'+self.id, render_handler)
			)

		// quit event
			const quit_handler = () => {
				self.delete_cache()
			}
			self.events_tokens.push(
				event_manager.subscribe('quit', quit_handler)
			)

		// change_lang event
			const change_lang_handler = () => {
				self.delete_cache()
			}
			self.events_tokens.push(
				event_manager.subscribe('change_lang', change_lang_handler)
			)

	// load additional files as css used by section_tool in self.config
		if(self.config && self.config.source_model==='section_tool') {
			self.load_section_tool_files()
		}

	// render_views
		// Definition of the rendering views that could be used.
		// Tools or another components could add specific views dynamically
		self.render_views = [
			{
				view	: 'default',
				mode	: 'edit',
				render	: 'view_default_edit_section'
			},
			{
				view	: 'default',
				mode	: 'list',
				render	: 'view_default_list_section'
			},
			{
				view	: 'graph',
				mode	: 'edit',
				render	: 'view_graph_edit_section',
				path	: './view_graph_edit_section.js'
			}
		]

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Loads all data needed to render the section: resolves the request_config into a
* concrete rqo, optionally fetches context+data from the server (when autoload is
* true), restores pagination from IndexedDB, resolves the columns_map, and creates
* the filter/paginator/inspector sub-instances if they do not yet exist.
*
* This method is safe to call multiple times — the paginator/inspector are guarded
* by null checks, and the filter instance is looked up through the shared registry
* so that the same search instance is reused across refresh cycles.
*
* The autoload path (autoload===true) follows this sequence:
*   1. Merge session values into the rqo (session_save, session_key, view).
*   2. Restore pagination from local DB (`data_manager.get_local_db_data`).
*   3. Call `build_autoload(self)` which calls the Dédalo API and populates
*      `self.datum` with `{ context: […], data: […] }`.
*   4. Destroy any existing child instances (avoids leaking DOM nodes on refresh).
*   5. Set `self.context`, normalising the 'list_thesaurus' mode alias to 'list'.
*   6. Set `self.data` and extract `self.section_id` from the first data entry.
*   7. Regenerate the rqo with session sqo from context if present.
*   8. Finalise and persist the pagination offset/limit.
*   9. Optionally inject a debug panel when SHOW_DEBUG is true.
*
* After the autoload block (or when skipped), the method always:
*   - Normalises mode from context (catching any 'list_thesaurus' not caught above).
*   - Calls `set_context_vars` to copy context properties onto self.
*   - Resolves `self.initiator` from the URL or the caller instance.
*   - Creates the paginator sub-instance and subscribes to paginator_goto_ events.
*   - Creates the inspector sub-instance when mode is 'edit' and permissions exist.
*   - Resolves the columns_map via `get_columns_map`.
*
* @param {boolean} [autoload=false] - When true, fetches context and data from the API
* @returns {Promise<boolean>} true on success; false when the API response is invalid
*   (e.g. missing context) or when the server returns a falsy result
*/
section.prototype.build = async function(autoload=false) {

	const self = this

	// status update
		self.status = 'building'

	// self.datum. On building, if datum is not created, creation is needed
		self.datum = self.datum || {
			data	: [],
			context	: []
		}
		self.data = self.data || {}

	// rqo
		const generate_rqo = async function(){

			if (!self.context) {
				// request_config_object. get the request_config_object from request_config
				self.request_config_object = self.request_config?.find(el => el.api_engine==='dedalo' && el.type==='main') || {}
			}else{
				// request_config_object. get the request_config_object from context
				 self.request_config_object = self.context?.request_config?.find(el => el.api_engine==='dedalo' && el.type==='main') || {};
			}

			// check request_config_object misconfigured issues (type = 'main' missed in request_config cases)
				if (self.request_config && !self.request_config_object) {
					console.warn('Warning: no request_config was found into the request_config. Maybe the request_config type is not set to "main"');
					console.warn('self.request_config:', self.request_config);
				}

			// rqo build
			const action	= 'search'
			// add_show is true for a TIME MACHINE read, to include the source language
			// data in the response. The test is sqo.mode — the ROW SOURCE — not the
			// render mode, which is retired (WC-2026-08-14-tm-ddo-mode-retired).
			const add_show	= (self.add_show)
				? self.add_show
				: (self.rqo?.sqo?.mode==='tm' || self.request_config_object?.sqo?.mode==='tm') ? true : false
			self.rqo = self.rqo || await self.build_rqo_show(
				self.request_config_object, // object request_config_object
				action,  // string action like 'search'
				add_show // bool add_show
			)

			// add session SQO when is present in the context
			// @see server `get_structure_context` sqo_session property addition
			if (self.context?.sqo_session && self.request_config_object) {

				// The stored sqo is the section's LAST read — a PAGE VIEW's
				// navigation state. A RECORD VIEW is excluded: the pin IS its
				// identity, and the session's found-set position would replace it
				// with another record.
				//
				// (!) The SAME object, never a copy: `this.context.sqo_session` IS
				// this instance's live sqo after the first adoption, and pagination
				// mutates it in place (update_pagination). A clone here made every
				// page turn rewind to the previous offset.
				//
				// (!) Never scrub `filter_by_locators` here either: on the live
				// object that would erase a caller's RESULT SET (search.js writes a
				// semantic search's ranked hits onto this very sqo before
				// navigating). A stored pin can no longer leak into a page view:
				// build_rqo_show states `filter_by_locators: []` when the client has
				// no pin, so the server never fills one from the session.
				if (!is_pinned_record_view(self)) {
					const session_sqo = self.context.sqo_session

					// request_config_object
					// Update on every build to preserve sync with the server section session
					self.request_config_object.sqo = session_sqo

					// rqo
					// Note that rqo is calculated once and need to be updated when build autoload is made
					// and the context is loaded / updated
					self.rqo.sqo = session_sqo
				}

				// dd15 is the TIME MACHINE section: its rows come from
				// matrix_time_machine, so the SQO row source is always 'tm'. (This is
				// sqo.mode — a row source — and is unaffected by the retirement of the
				// 'tm' RENDER mode, WC-2026-08-14-tm-ddo-mode-retired.)
				if( self.tipo==='dd15' ){
					self.rqo.sqo.mode = 'tm'
					self.request_config_object.sqo.mode = 'tm'
				}
			}
		}
		await generate_rqo()

	// filter search
		if (self.filter===null) {
			// keyed, registered instance (no longer a bare `new search()`).
			// id_variant disambiguates section searches from area searches that
			// could otherwise share section_tipo/mode/lang.
			self.filter = await get_instance({
				model			: 'search',
				section_tipo	: self.section_tipo,
				mode			: self.mode,
				lang			: self.lang,
				id_variant		: self.model,
				caller			: self
			})
			// preload search (experimental disable now)
			const pre_built_search = false
			if (pre_built_search && self.mode==='list') {
				dd_request_idle_callback(
					() => {
						self.filter.build()
					}
				)
			}
		}

	// load from DDBB
		if (autoload===true) {

			// update rqo with session values
				self.rqo.source.session_save	= self.session_save
				self.rqo.source.session_key		= self.session_key

			// view
				self.rqo.source.view = self.view

			// pagination. Set pagination from saved local_db_data if exists
			// Updates the rqo.sqo pagination properties with local DB values
			// (!) Never into a RECORD VIEW: the stored offset belongs to a found
			// set, and beside the single pin it would skip the only row (an empty
			// edit form). See is_pinned_record_view.
				if (self.session_save && !is_pinned_record_view(self)) {
					// Get pagination value from local database
					const pagination_mode = self.mode==='edit' ? self.mode : 'list';
					const saved_pagination = await data_manager.get_local_db_data(
						`${self.tipo}_${pagination_mode}`,
						'pagination'
					);

					// ! Do not apply here default values to prevent overwrite server custom limit like 'dd542' (Activity)
					const saved_limit	= saved_pagination?.value?.limit ?? null;
					const saved_offset	= saved_pagination?.value?.offset ?? null;
					// fill sqo empty values with final values if necessary (check null and undefined cases)
					if (self.rqo.sqo.limit==null && saved_limit!==null) {
						self.rqo.sqo.limit = saved_limit;
					}
					if (self.rqo.sqo.offset==null && saved_offset!==null) {
						self.rqo.sqo.offset = saved_offset;
					}
				}

				// dd15 is the TIME MACHINE section: its rows come from
				// matrix_time_machine, so the SQO row source is always 'tm'. (This is
				// sqo.mode — a row source — and is unaffected by the retirement of the
				// 'tm' RENDER mode, WC-2026-08-14-tm-ddo-mode-retired.)
				if( self.tipo==='dd15' ){
					self.rqo.sqo.mode = 'tm'
				}

			// build_autoload
			// Use unified way to load context and data with
			// errors and not login situation managing
				const api_response = await build_autoload(self)

				// server: wrong response
				if (!api_response) {
					return false
				}
				// server: bad build context
				const datum = response_data(api_response)
				if(!datum.context.length){
					console.error("Error, section without context:", api_response);
					return false
				}

			// destroy dependencies
				await self.destroy(
					false, // bool delete_self
					true, // bool delete_dependencies
					false // bool remove_dom
				)

			// set the result to the datum
				self.datum = datum

			// set Context
				// context is set only when the origin context is empty,
				// if the instance has a previous context, it will need to be preserved.
				// because the context could be modified by ddo configuration and it can not be changed
				// ddo_map -----> context
				// ex: oh27 define the specific ddo_map for rsc368
				// 		{ mode: list, view: line, children_view: text ... }
				// if you call to API to get the context of the rsc368 the context will be the default config
				// 		{ mode: edit, view: default }
				// but it's necessary to preserve the specific ddo_map configuration in the new context.
				// Context is set and changed in section_record.js to get the ddo_map configuration
				if(!self.context){
					// try matching by tipo first (standard case),
					// then fall back to model==='section' for area-wrapped sections
					// where self.tipo (area tipo) differs from the section tipo in datum
					const context = self.datum?.context?.find(el => el.tipo===self.tipo)
						|| self.datum?.context?.find(el => el.model==='section')
						|| {}
					if (Object.keys(context).length === 0) { // Checks if it's literally an empty object
						console.error("Context not found for tipo:", self.tipo, "in self.datum.context:", self.datum?.context);
						// fallback to prevent null crash downstream
						self.context = {
							mode			: self.mode || 'edit',
							section_tipo	: self.section_tipo,
							tipo			: self.tipo
						}
					}else{
						self.context = context
					}
				}

			// Update mode.
			// Take care of the 'list_thesaurus' mode case. It is used only to retrieve custom data from server (on build section)
			// but in client is not used. Instead, change it to 'list' mode after getting the API data.
				if (self.context.mode === 'list_thesaurus') {
					self.context.mode = 'list';
				}
				self.mode = self.context.mode;

			// set Data
				self.data		= self.datum?.data?.find(el => el.tipo===self.tipo && el.typo==='sections') || {}
				self.section_id = null; // Initialize to null
				if (self.mode !== 'list' && self.data && Array.isArray(self.data.entries)) {
					const found = self.data.entries.find(el => el.section_tipo === self.section_tipo);
					// note the explicit null/undefined test: section_id 0 is a legitimate id
					if (found && found.section_id !== undefined && found.section_id !== null) {
						self.section_id = found.section_id;
					} else {
						console.warn('Empty value found or section_id missing in self.data.entries: ', self.data.entries);
					}
				}

			// address bar. The record is known only now — page.navigate pushed the
			// entry when it accepted the navigation, before this read finished.
				sync_url_record(self)

			// rqo regenerate
				await generate_rqo()

			// pagination update
				const request_config		= self.context?.request_config || []
				const request_config_dedalo	= request_config.find(el => el.api_engine==='dedalo') || {}
				// ONE SELECTOR PER READ. A record view is ONE record: limit 1 and no
				// position at all — offset is a found-set coordinate, and beside the
				// single pin it skips the only row. Its pagination is neither read
				// (above) nor written: the stored list position belongs to the list,
				// and the view reporting 1/1 is the truth.
				if (is_pinned_record_view(self)) {
					self.rqo.sqo.limit	= 1
					self.rqo.sqo.offset	= 0
					// total 1 lets the paginator render its single-record state
					self.total = 1
				}else{
					// fill values that are not defined previously with safe fallback to defaults (check null and undefined cases)
					if (self.rqo.sqo.limit==null) {
						self.rqo.sqo.limit = request_config_dedalo.show?.sqo_config?.limit ?? (self.mode==='edit' ? 1 : 10)
					}
					if (self.rqo.sqo.offset==null) {
						self.rqo.sqo.offset = request_config_dedalo.show?.sqo_config?.offset ?? 0
					}
					// On session_save, always fix current pagination value, even if is not different
					// Updates local DB pagination values. Don't await here
					if (self.session_save) {
						const pagination_mode = self.mode==='edit' ? self.mode : 'list';
						data_manager.set_local_db_data(
							{
								id		: `${self.tipo}_${pagination_mode}`,
								value	: {
									limit	: self.rqo.sqo.limit,
									offset	: self.rqo.sqo.offset
								}
							},
							'pagination'
						)
						.catch(error => {
							console.error("Error saving pagination to local DB:", error);
						});
					}else{
						// editing one record case in session_save false
						if (self.mode==='edit' && self.section_id) {
							// fix offset to 0 but do not store the value
							self.rqo.sqo.offset = 0
							// reset total to 1 to allow paginator render properly
							self.total = 1
						}
					}
				}

			// view
				if (self.context.view) {
					self.view = self.context.view
				}

			// debug
				if(SHOW_DEBUG===true) {

					// render_handler
					const render_handler = () => {

						// remove event subscription
						event_manager.unsubscribe(debug_token)

						const debug = document.getElementById('debug')
						if (!debug) {
							console.log('Ignored debug');
							return
						}

						// clean
							while (debug.firstChild) {
								debug.removeChild(debug.firstChild)
							}

						// button_debug add
							const button_debug = ui.create_dom_element({
								element_type	: 'button',
								class_name		: 'info eye',
								inner_html		: get_label.debug || "Debug",
								parent			: debug
							})
							button_debug.tabIndex = -1;
							const click_handler = () => {

								if (debug_container.hasChildNodes()) {
									debug_container.classList.toggle('hide')
									return
								}

								// collect debug data
								load_data_debug(self, api_response, self.rqo)
								.then(function(info_node){
									// debug.classList.add("hide")
									if (info_node) {
										debug_container.appendChild(info_node)
									}

									// scroll debug to top of page
										const bodyRect	= document.body.getBoundingClientRect()
										const elemRect	= debug.getBoundingClientRect()
										const offset	= elemRect.top - bodyRect.top
										window.scrollTo({
											top			: offset,
											left		: 0,
											behavior	: 'smooth'
										});
								})
							}
							button_debug.addEventListener('click', click_handler)

						// debug_container
							const debug_container = ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'debug_container',
								parent			: debug
							})

						// show debug node removing hide style
							debug.classList.remove('hide')
					}
					const debug_token = event_manager.subscribe('render_'+self.id, render_handler)
					self.events_tokens.push(debug_token)
				}
		}//end if (autoload===true)

	// Safe update mode.
	// Take care of the 'list_thesaurus' mode case. It is used only to retrieve custom data from server
	// but in client is not used. Instead, always change it to 'list' mode.
		if (self.context.mode === 'list_thesaurus') {
			self.context.mode = 'list';
		}
		self.mode = self.context.mode;

	// update instance properties from context
		set_context_vars(self, self.context)

	// initiator . URL defined var or Caller of parent section
	// this is a param that defined who is calling to the section, sometimes it can be a tool or page or ...,
		const searchParams = new URLSearchParams(window.location.search);
		const initiator = searchParams.has('initiator')
			? searchParams.get('initiator')
			: self.caller!==null
				? self.caller.id
				: null
		// fix initiator
		// Strip any '#fragment' appended to the id (e.g. from URL hash navigation)
		// (!) Absence is ALWAYS null, never false: consumers test it with
		// `self.initiator?.includes(...)` and optional chaining does not
		// short-circuit on false (`false.includes` -> not a function).
			self.initiator = typeof initiator==='string'
				? initiator.split('#')[0]
				: null

	// paginator
		if (self.paginator===null) {

			self.paginator = new paginator()
			self.paginator.init({
				caller	: self,
				mode	: self.mode
			})

			// event paginator_goto_
				const paginator_goto_handler = (offset) => {
					self.update_pagination(offset)
				}
				self.events_tokens.push(
					event_manager.subscribe('paginator_goto_'+self.paginator.id, paginator_goto_handler)
				)
		}//end if (!self.paginator)

	// inspector
		if (self.inspector==null && self.mode==='edit' && self.permissions) {

			const current_inspector = new inspector()
			current_inspector.init({
				section_tipo	: self.section_tipo,
				section_id		: self.section_id,
				caller			: self
			})
			// fix section inspector
			self.inspector = current_inspector
		}

	// reset fixed_columns_map (prevents to apply rebuild_columns_map more than once)
		self.fixed_columns_map = false

	// columns_map. Get the columns_map to use into the list
		self.columns_map = get_columns_map({
			context			: self.context,
			datum_context	: self.datum.context
		})

	// debug
		if(SHOW_DEBUG===true) {
			// console.log("self.context section_group:",self.datum.context.filter(el => el.model==='section_group'));
			// load_section_data_debug(self.section_tipo, self.request_config, load_section_data_promise)
			// console.log("__Time to build", self.model, "(ms):", performance.now()-t0);
			// dd_console(`__Time to build ${self.model} ${Math.round(performance.now()-t0)} ms`, 'DEBUG')

			// debug duplicates check
				const ar_used = []
				for(const element of self.datum.data) {

					if (element.matrix_id) { continue; } // skip verification in matrix data

					const index = ar_used.findIndex(item => item.tipo===element.tipo &&
													item.section_tipo===element.section_tipo &&
													item.section_id==element.section_id &&
													item.from_component_tipo===element.from_component_tipo &&
													item.parent_section_id==element.parent_section_id
													// && item.row_section_id==element.row_section_id
													// && (item.matrix_id && item.matrix_id==element.matrix_id)
													&& (item.tag_id && item.tag_id==element.tag_id)
													)
					if (index!==-1) {
						console.error("SECTION ERROR. self.datum.data contains duplicated elements:", ar_used[index]); // clone(self.datum.data)
					}else{
						ar_used.push(element)
					}
				}
		}

	// status update
		self.status = 'built'


	return true
}//end build



/**
* RENDER
* Delegates to the common render implementation which dispatches to the appropriate
* mode-specific render method (edit, list, solved, tm, …) based on `self.mode`.
* After the common render completes, publishes the 'render_instance' event so that
* the inspector, paginator, and other page-level listeners can react.
*
* The `render_` event (subscribed in init) fires from within common.prototype.render
* and handles the post-render tasks (menu label update, search panel state restore).
*
* Performance timing is logged when SHOW_DEBUG is true so that render hot-paths
* can be profiled without attaching a full DevTools session.
*
* @param {Object} [options={}] - Render options forwarded to common.prototype.render
* @param {string} [options.render_level] - Depth control: 'full' renders the entire
*   section including child records; 'content' re-renders only the inner content area
* @returns {Promise<HTMLElement>} The outermost DOM node produced by the render path,
*   also stored in `self.node`
*/
section.prototype.render = async function(options={}) {
	const t0 = performance.now()

	const self = this

	// call generic common render
		const result_node = await common.prototype.render.call(this, options)

	// event publish
		event_manager.publish('render_instance', self)

	// add node to instance
		self.node = result_node

	// debug
		if(SHOW_DEBUG===true) {
			dd_console(`__Time to render ${self.model} ${Math.round(performance.now()-t0)} ms`, 'DEBUG')
			// console.log('get_all_instances:', get_all_instances().length);
			// console.log('event_manager.get_events():', event_manager.get_events().length);
			// console.log('self.datum.context.length:', self.datum.context.length);
			// console.log('self.datum.data.length:', self.datum.data.length);
		}


	return result_node
}//end render



/**
* GET_SECTION_RECORDS
* Parallel factory that converts a page of raw locator entries into fully built
* section_record instances ready for rendering.
*
* Each locator from `options.entries` (or `self.data.entries`) is passed to
* `get_instance` with model='section_record'. All `get_instance` + `build` calls
* are fired concurrently via Promise.all so that the time cost is bounded by the
* slowest single record rather than by the total count.
*
* The resulting array preserves the original entry order (Promise.all guarantees
* order) with failed/null instances filtered out so callers can iterate directly
* without null checks.
*
* When a locator has a `tag_id` property (Translation Memory row identifier), the
* tag_id is appended to `id_variant` (prefixed with '_l') to ensure the instance
* key is unique within the TM matrix, where a record can appear multiple times with
* different tag contexts.
*
* @param {Object} options - Configuration object
* @param {Object} options.caller - The section instance that owns this call;
*   many default values are sourced from `options.caller`
* @param {Array<Object>} [options.entries] - Array of locator objects
*   `{ section_tipo, section_id, paginated_key, tag_id? }`; defaults to
*   `caller.data.entries`
* @param {string} [options.tipo] - Ontology tipo forwarded to each section_record;
*   defaults to `caller.tipo`
* @param {string} [options.mode='list'] - Render mode for each section_record
* @param {Array} [options.columns_map] - Column layout forwarded to each record
* @param {string|null} [options.id_variant] - Variant suffix for instance dedup
* @param {string} [options.view='default'] - View variant forwarded in the context
* @param {string|null} [options.column_id] - ID of the column component (list views)
* @param {Object} [options.datum] - Datum to share across all records; defaults to
*   `caller.datum`
* @param {Object} [options.request_config] - request_config override; cloned before
*   use so records cannot mutate each other's config
* @param {string} [options.fields_separator=' '] - Separator string used when
*   concatenating multi-component list values
* @param {string} [options.lang] - Language tag; defaults to `caller.section_lang`
*   or `caller.lang`
* @param {number} [options.row_key_base=0] - Offset added to each entry's index
*   for its `row_key`: a row window (window_section_rows) materializes one entry
*   at a time and must hand it the row_key it has in the whole page
* @param {number|string|null} [options.matrix_id] - Time-machine row id; defaults
*   to `caller.matrix_id`. Keys every section_record (and, forwarded, its
*   children) to that TM row, so a tool_time_machine preview never shares
*   instances with the live 'Now' pane or the page
* @param {string|null} [options.data_source] - 'tm' for a time-machine preview;
*   defaults to `caller.data_source`. Forwarded only to the records' dataframe
*   children (see section_record build_instance)
* @returns {Promise<Array<Object>>} Array of successfully built section_record
*   instances (nulls from failed builds are excluded)
*/
export const get_section_records = async function(options) {

	// options
		const self				= options.caller
		if (!self) {
			console.error('Error: get_section_records requires a caller');
			return []
		}

		const tipo				= options.tipo || self.tipo || null
		const mode				= options.mode || self.mode || 'list'
		const columns_map		= options.columns_map || self.columns_map || []
		const id_variant		= options.id_variant || self.id_variant || null
		const view				= options.view || 'default'
		const column_id			= options.column_id || self.column_id || null
		const datum				= options.datum || self.datum || {data:[], context:[]}
		const context			= self.context || {}
		const request_config	= (options.request_config)
			? clone(options.request_config)
			: clone(context.request_config)
		const fields_separator	= options.fields_separator || context.fields_separator || ' '
		const lang				= options.lang || self.section_lang || self.lang
		const entries			= options.entries || ((self.data && self.data.entries)
			? self.data.entries
			: [])
		const row_key_base		= Number.isInteger(options.row_key_base) ? options.row_key_base : 0
		// matrix_id / data_source — time machine. Always from the CALLER (a
		// tool_time_machine preview portal), NEVER from locator.matrix_id: dd15
		// history-list entries carry one matrix_id per row, and re-keying on it
		// would stamp that id onto every dd15 cell source. Without them, the
		// preview's section_records collide with the live ones (same key) and
		// the preview reuses the live children, live dataframe included.
		const matrix_id			= options.matrix_id || self.matrix_id || null
		const data_source		= options.data_source || self.data_source || null

	// iterate records
		const ar_promises		= []
		const entries_length	= entries.length
		for (let i = 0; i < entries_length; i++) {

			const locator				= entries[i]
			const current_section_id	= locator.section_id
			const current_section_tipo	= locator.section_tipo

			const instance_options = {
				model			: 'section_record',
				tipo			: tipo,
				section_tipo	: current_section_tipo,
				section_id		: current_section_id,
				mode			: mode,
				lang			: lang,
				context			: {
					view				: view,
					request_config		: request_config,
					fields_separator	: fields_separator
				},
				datum			: datum,
				row_key 		: row_key_base + i,
				caller			: self,
				paginated_key	: locator.paginated_key,
				columns_map		: columns_map,
				column_id		: column_id,
				locator			: locator,
				id_variant		: id_variant,
				matrix_id		: matrix_id,
				data_source		: data_source
			}

			// locator tag_id modifies id_variant when is present
				if (locator.tag_id) {
					const tag_id_add = '_l' + locator.tag_id
					instance_options.id_variant = (instance_options.id_variant)
						? instance_options.id_variant + tag_id_add
						: tag_id_add
				}

			// promise add and continue init and build
				ar_promises.push((async () => {
					const current_section_record = await get_instance(instance_options)
					if (current_section_record) {
						const build_result = await current_section_record.build()
						if (build_result === false) {
							return null
						}
						return current_section_record
					}
					return null
				})())
		}//end for (let i = 0; i < entries_length; i++)

	// ar_instances. When all section_record instances are built, set them
		const section_records_all = await Promise.all(ar_promises)

		// filter out null results from failed get_instance
		const section_records = section_records_all.filter(el => el !== null)


	return section_records
}//end get_section_records



/**
* WINDOW_SECTION_ROWS
* THE row-materialization door of every list view (audit P2-31 / CLI-29): the
* rows of a page are handed to a row window (common/js/row_window.js) that
* builds section_record instances and their DOM only for the rows the viewport
* can reach — at most ROW_WINDOW_MAX_ROWS at once — and releases them again
* past the window's far edge. A list view never loops its rows itself.
*
* Each row is either a raw locator entry (`{section_tipo, section_id, …}` from
* `self.data.entries` — built through get_section_records ONE AT A TIME, with
* its page-wide `row_key`, and destroyed when released) or an already-built
* section_record instance (the TM inspector panels pre-build theirs; then only
* the DOM is windowed and the instance survives a release).
*
* Materialized instances are pushed into `self.ar_instances` — so it holds only
* the LIVE rows, never the page — and a released row leaves it through the
* instance's own destroy (common.prototype.destroy step 8). Emptiness is a
* question for the row list, not for ar_instances.
*
* The window is stored as `self.row_window` (the previous one is destroyed);
* section.prototype.destroy and component_portal.prototype.destroy release it.
*
* A view whose row is MORE than one section_record (the mosaic edit portal
* builds a tile, a hover overlay and an alternative table row per entry) hands
* its own `materialize(row, index, build_row)` and `release(row, index, node)`:
* `build_row(records_options)` builds ONE section_record for that row through
* get_section_records (page-wide row_key, registered in ar_instances) — the
* view never calls the factory itself, so the census still sees one door.
*
* @param {Object} options
* @param {Object} options.caller - The section / portal instance that owns the rows.
* @param {HTMLElement} options.container - The content_data node rows go into.
* @param {Array} options.rows - Locator entries or section_record instances.
* @param {Object} [options.render_options] - Passed to each row's render().
* @param {Object} [options.records_options] - Passed to get_section_records
*   (mode, view, columns_map, id_variant…).
* @param {Function} [options.materialize] - async (row, index, build_row) → node|null.
*   Replaces the default one-instance materialization; the caller then owns
*   what it built and MUST tear it down in `options.release`.
* @param {Function} [options.release] - async (row, index, node). Required with
*   a custom materialize; ignored otherwise.
* @param {number} [options.row_height] - Estimated px per row for the spacers.
* @param {string} [options.spacer='grid'] - Spacer style, see row_window.
* @returns {Promise<Object>} The row window handle (already filled).
*/
export const window_section_rows = async function(options) {

	const self				= options.caller
	const container			= options.container
	const rows				= Array.isArray(options.rows) ? options.rows : []
	const render_options	= options.render_options || {}
	const records_options	= options.records_options || {}

	if (!self || !container) {
		console.error('Error: window_section_rows requires a caller and a container');
		return null
	}
	self.ar_instances = self.ar_instances || []

	// index → the instance behind a materialized row
	const instances = new Map()

	// build_row. ONE section_record for the row at `index`, registered in
	// ar_instances. The default materialization and a custom one both build
	// through here.
	const build_row = async (row, index, override) => {
		const built = await get_section_records({
			...records_options,
			...(override || {}),
			caller			: self,
			entries			: [row],
			row_key_base	: index
		})
		const instance = built[0] || null
		if (instance && !self.ar_instances.includes(instance)) {
			self.ar_instances.push(instance)
		}
		return instance
	}

	const custom = typeof options.materialize==='function'
	if (custom && typeof options.release!=='function') {
		console.error('Error: window_section_rows: a custom materialize needs a release');
		return null
	}

	const row_window = create_row_window({
		owner		: self,
		container	: container,
		items		: rows,
		spacer		: options.spacer || 'grid',
		row_height	: options.row_height,
		materialize	: custom
			? (row, index) => options.materialize(row, index, (override) => build_row(row, index, override))
			: async (row, index) => {
				let instance = row
				if (!instance || typeof instance.render!=='function') {
					instance = await build_row(row, index)
					if (!instance) {
						return null
					}
				}
				instances.set(index, instance)
				return instance.render(render_options)
			},
		release		: custom
			? (row, index, node) => options.release(row, index, node)
			: async (row, index) => {
				const instance = instances.get(index)
				instances.delete(index)
				// a pre-built instance is the caller's: only its DOM leaves the window
				const owned = !row || typeof row.render!=='function'
				if (owned && instance && instance.status!=='destroyed') {
					await instance.destroy(
						true, // delete_self
						true, // delete_dependencies
						true  // remove_dom
					)
				}
			}
	})
	await row_window.fill()


	return row_window
}//end window_section_rows



/**
* LOAD_SECTION_TOOL_FILES
* Loads CSS and other static assets required by a section_tool configuration.
* Called during init when `self.config.source_model === 'section_tool'`.
*
* Section tools (e.g. diffusion tools, export tools) are mounted inside a regular
* section but may define their own icon via CSS `mask-image: url('../img/icon.svg')`.
* The CSS file path follows the convention:
*   `<tool_base_url(model)>/css/<model>.css`
*
* The actual CSS injection is performed by `load_style` (from utils), which prevents
* double-loading the same URL.
*
* @returns {void}
*/
section.prototype.load_section_tool_files = function() {

	const self = this

	// css file load
		const model	= self.config.tool_context.model
		const url	= tool_base_url(model) + '/css/' + model + '.css'
		load_style(url)

	// debug
		if(SHOW_DEBUG===true) {
			console.log('loaded section_tool files:', url);
		}
}//end load_section_tool_files



/**
* CREATE_SECTION
* Issues an API 'create' request to insert a new blank record in this section and
* returns the new record's section_id on success.
*
* The request is built via `create_source(self, 'create')` which packages the
* section tipo, lang, and credentials into the standard source envelope that the
* Dédalo PHP API expects.
*
* A refused request is handed to `handle_api_error`, which renders it through the
* one policy/renderer pair (see error_policy.js).
*
* @returns {Promise<number|string|null>} The new record's section_id (positive
*   integer) on success; null if the API returned a falsy or non-positive result
*/
section.prototype.create_section = async function () {

	const self = this

	// source
		const source = create_source(self, 'create')

	// data_manager. delete
		const rqo = {
			action	: 'create',
			source	: source
		}
		const api_response = await data_manager.request({
			body : rqo
		})

		// manage errors
		// The policy renders the refusal (toast / no-access panel / relogin) in
		// the user's language; the console line stays for the developer.
		if (request_failed(api_response)) {
			console.error('create_section api_response error:', api_response.error);
			await handle_api_error(api_response.error, {wrapper: self.node});
		}

		const new_section_id = response_data(api_response)
		if (new_section_id && new_section_id>0) {

			return new_section_id

		}else{
			console.error('Error on create record!', api_response);
		}


	return null
}//end create_section



/**
* DUPLICATE_SECTION
* Issues an API 'duplicate' request to create a deep copy of an existing record and
* returns the new copy's section_id on success.
*
* The source envelope is built the same way as create_section, then augmented with
* the source `section_id` so the server knows which record to clone.
*
* The comment "data_manager. delete" below is a copy-paste artefact from another
* method; the action here is 'duplicate', not 'delete'.
*
* @param {number|string} section_id - The section_id of the record to copy
* @returns {Promise<number|string|null>} The new record's section_id on success;
*   null on API failure
*/
section.prototype.duplicate_section = async function (section_id) {

	const self = this

	// source
		const source = create_source(self, 'duplicate')
		// add section_id used as data source to clone
		source.section_id = section_id

	// data_manager. delete
		const rqo = {
			action	: 'duplicate',
			source	: source
		}
		const api_response = await data_manager.request({
			body : rqo
		})

		// manage errors
		// The policy renders the refusal (toast / no-access panel / relogin) in
		// the user's language; the console line stays for the developer.
		if (request_failed(api_response)) {
			console.error('duplicate_section api_response error:', api_response.error);
			await handle_api_error(api_response.error, {wrapper: self.node});
		}

		const new_section_id = response_data(api_response)
		if (new_section_id && new_section_id>0) {

			return new_section_id

		}else{
			console.error('Error on duplicate record!', api_response);
		}


	return null
}//end duplicate_section



/**
* DELETE_SECTION
* Issues an API 'delete' request to permanently remove one or more records
* described by the provided SQO.  The caller is responsible for presenting a
* confirmation dialog before calling this method (typically via
* `render_delete_record_dialog`).
*
* `delete_diffusion_records` defaults to true so that any published/diffused
* copies of the deleted record are also cleaned up via the diffusion pipeline.
* Pass `false` to skip diffusion cleanup (e.g. during bulk test data removal).
*
* The SQO is cloned before being sent so that the caller's copy is not mutated
* by the API layer.
*
* @param {Object} options - Delete parameters
* @param {Object} options.sqo - Search Query Object defining which records to delete
* @param {string} [options.delete_mode] - Server-side delete mode ('logical', 'physical', …)
* @param {boolean} [options.delete_diffusion_records=true] - Whether to cascade the
*   delete into the diffusion (publication) layer
* @returns {Promise<boolean>} true when the server confirms deletion; false on failure
*/
section.prototype.delete_section = async function (options) {

	const self = this

	// options
		const sqo						= clone(options.sqo)
		const delete_mode				= options.delete_mode
		// const caller_dataframe			= options.caller_dataframe || null
		const delete_diffusion_records	= options.delete_diffusion_records ?? true

	// source
		const source			= create_source(self, 'delete')
		source.section_id		= self.section_id
		source.delete_mode		= delete_mode
		// source.caller_dataframe	= caller_dataframe

	// data_manager. delete
		const rqo = {
			action	: 'delete',
			source	: source,
			sqo		: sqo,
			options : {
				delete_diffusion_records : delete_diffusion_records
			}
		}
		const api_response = await data_manager.request({
			body	: rqo,
			// this method renders the delete notices itself, next to the record
			// it could not remove — the page-level toast would say it twice.
			notices	: 'caller'
		})

		// manage errors
		// The policy renders the refusal (toast / no-access panel / relogin) in
		// the user's language; the console line stays for the developer.
		if (request_failed(api_response)) {
			console.error('delete_section api_response error:', api_response.error);
			await handle_api_error(api_response.error, {wrapper: self.node});
		}

		// notices. A delete SUCCEEDS with a coded, non-fatal fact when the server
		// kept a record because one of its children refused to go
		// (`record.delete_children_refused`, `details.not_deleted` = the refused
		// ids, comma-joined). What was deleted really was deleted, so this is not
		// a failure — it is the sentence the old alert used to show, rendered
		// through the one error renderer (label + placeholders, never innerHTML)
		// inside the section's own wrapper.
		if (Array.isArray(api_response?.notices) && api_response.notices.length>0) {
			for (const notice of api_response.notices) {
				await handle_api_notice(notice, {
					wrapper		: self.node,
					request_id	: api_response.request_id
				})
			}
		}

		const deleted = response_data(api_response)
		if (deleted && deleted.length>0) {

			// all is OK
			return true
		}

	// delete has failed. Notify and return false
		console.error('Error on delete records!', api_response);


	return false
}//end delete_section



/**
* HOLDS_COMPONENT_LOCKS
* False for a read-only Time Machine list: its rows come from matrix_time_machine
* (sqo.mode 'tm' — the ROW SOURCE), or it sits on a TM surface (the dd15 history
* list, a tool_time_machine preview — is_time_machine_view walks the caller chain).
* Such a list never edits, so it never acquires a component lock and has none to
* clean up. Every TM list today is a dd15 section (inspector Latest changes /
* Component history, tool_time_machine), and a bare dd15 is a section a non-admin
* may not name (WC-2026-10-23-own-lock-cleanup-ungated: the inspector "Latest
* changes" pagination got a 403). The sqo.mode test also covers a TM list scoped
* to a real section, where the cleanup would release the user's LIVE edit locks.
* @param {Object} instance - section instance
* @returns {boolean} true when the section's navigation must clean the user's locks
*/
export const holds_component_locks = function(instance) {

	if (instance?.rqo?.sqo?.mode==='tm' || instance?.request_config_object?.sqo?.mode==='tm') {
		return false
	}

	return !is_time_machine_view(instance)
}//end holds_component_locks



/**
* NAVIGATE
* Refreshes the section with a new SQO (typically a changed offset/limit after
* pagination or a sort-column change) and optionally records the navigation in
* the browser history so the back/forward buttons work.
*
* Flow:
*   1. Ask the user to confirm discarding unsaved changes (via check_unsaved_data).
*   2. Destroy any floating autocomplete widget.
*   3. Execute an optional pre-navigation callback.
*   4. Add 'loading' CSS classes to the body and inspector nodes.
*   5. Call `self.refresh()` which destroys child instances, re-runs build, and
*      re-renders the section.
*   6. Remove 'loading' classes.
*   7. Optionally push a browser history entry via `push_browser_history`.
*   8. Fire a background worker call to clear server-side section locks for the
*      current user so other sessions can acquire the lock on the record — never
*      from a read-only Time Machine list (holds_component_locks), which holds none.
*
* The 'loading' class is applied to `self.node_body` (the section content area)
* and to the inspector node rather than the entire section wrapper so that the
* toolbar remains interactive during the refresh.
*
* @param {Object} options - Navigation options
* @param {Function} [options.callback] - Async function executed before the refresh;
*   useful for saving state before the section re-builds
* @param {boolean} [options.navigation_history=false] - When true, push an entry to
*   the browser history API so the user can navigate back
* @param {Object} [options.sqo] - The SQO that triggered this navigation (used for
*   the history entry; the actual SQO used for the refresh comes from `self.rqo.sqo`
*   after update_pagination has already mutated it)
* @returns {Promise<boolean>} false if the user cancelled the unsaved-data dialog;
*   true otherwise
*/
section.prototype.navigate = async function(options) {

	const self = this

	// options
		const callback				= options.callback
		const navigation_history	= options.navigation_history ?? false
		const sqo					= options.sqo

	// check_unsaved_data
		const result = await check_unsaved_data({
			confirm_msg : 'section: ' + (get_label.discard_changes || 'Discard unsaved changes?')
		})
		if (!result) {
			// user selects 'cancel' in dialog confirm. Stop navigation
			return false
		}

	// remove aux items
		if (window.page_globals.service_autocomplete) {
			window.page_globals.service_autocomplete.destroy(true, true, true)
		}

	// callback execute
		if (callback) {
			await callback()
		}

	// loading styles
		if (self.node_body){
			self.node_body.classList.add('loading')
		}
		if (self.inspector && self.inspector.node) {
			self.inspector.node.classList.add('loading')
		}

	// refresh
		await self.refresh({
			destroy : false // avoid to destroy here to allow section to recover from loosed login scenarios
		})

	// loading styles
		if (self.node_body){
			self.node_body.classList.remove('loading')
		}
		if (self.inspector && self.inspector.node) {
			self.inspector.node.classList.remove('loading')
		}

	// navigation history. When user paginates, store navigation history to allow browser navigation too
		if (navigation_history===true) {

			const title		= self.id
			const source	= create_source(self, null)

			// url search. The address bar carries the record while one is open:
			// a section deep link with an id IS the edit view (server `start`
			// forces it), so `id` must follow the record when paginating in edit
			// mode and must never survive into a list.
				const url_vars = url_vars_to_object(location.search)
				const with_record = self.mode==='edit' && self.section_id!==null && self.section_id!==undefined
				let url
				if (with_record) {
					url_vars.id = self.section_id
					url = '?' + object_to_url_vars(url_vars)
				}else{
					// absence on the wire, without the delete operator
					const { id: _url_id, ...vars_without_id } = url_vars
					url = '?' + object_to_url_vars(vars_without_id)
				}

			// browser navigation update
				push_browser_history({
					source				: source,
					sqo					: sqo,
					event_in_history	: false,
					title				: title,
					url					: url
				})
		}

	// clean previous locks of current user in current section.
	// A read-only Time Machine list holds no lock: it sends nothing (holds_component_locks)
		if (!holds_component_locks(self)) {
			return true
		}
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
							section_tipo	: self.tipo,
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
		);


	return true
}//end navigate



/**
* NAVIGATE_TO_NEW_SECTION
* Transitions the section to edit mode on the freshly created (or duplicated) record
* identified by `section_id`. Called by new_section_handler and
* duplicate_section_handler after a successful API create/duplicate call.
*
* The navigation is performed by publishing a 'user_navigation' event that page.js
* intercepts. This decouples the section from the page routing logic and allows
* the transition to be intercepted or decorated by other listeners.
*
* Three navigation strategies exist, controlled by the local `filter_mode` constant:
*
*   'legacy' (current default):
*     Sets `sqo.filter_by_locators = null` so that `build_rqo_show` regenerates
*     it from `self.section_id`, which will be updated on the next build.
*     Offset is reset to 0 because only the new record is expected.
*
*   'preserve_filter':
*     Keeps existing filter clauses active and appends a new $or clause targeting
*     the new record by section_id via the component_section_id path. Offset is
*     set to `self.total` to land on the last page.  (Implemented but not active.)
*
*   'reset_filter':
*     Clears the filter entirely, fetches the real unfiltered total, and sets
*     offset to `total - 1` to land on the last record.  (Implemented but not active.)
*
* Pagination state for both list and edit modes is persisted to the local DB before
* the navigation event so that the receiving section build picks up the correct
* offset.
*
* @param {number|string} section_id - The newly created record's section_id;
*   must be truthy or the method throws
* @returns {Promise<boolean>} true after publishing the navigation event
* @throws {Error} if section_id is falsy or if an unexpected error occurs
*/
section.prototype.navigate_to_new_section = async function(section_id) {

	const self = this

	// Validate input section_id
	if (!section_id) {
		throw new Error('section_id is required');
	}

	try {

		// Create the search source
		const source = create_source(self, 'search');
		source.section_id	= section_id
		source.mode			= 'edit'

		// sqo
		// Check current sqo from rqo
		if (!self.rqo?.sqo) {
		    console.error('Cannot navigate: Search Query Object (sqo) is missing.');
		    return false;
		}
		// Clone current sqo to preserve filters.
		const sqo = clone(self.rqo.sqo)

		// limit
		// New record creation navigates to edit mode. So, set always limit to 1
		sqo.limit = 1

		// filter_by_locators.
		// (!) Its important to pass an empty array [] to prevent auto-generated value in common.build_rqo_show
		sqo.filter_by_locators = []

		// filter_mode. Allowed modes : reset_filter | preserve_filter | legacy
		const filter_mode = 'legacy'
		if (filter_mode==='preserve_filter') {

			// Add existing filter items if they exist as $or / $and
			const current_filter_items = sqo.filter?.$and
				? sqo.filter.$and.length
				: sqo.filter?.$or
					? sqo.filter.$or.length
					: 0;
			if (current_filter_items>0) {

				// new_filter. Create a new filter
				const new_filter = {
					'$or' : []
				}

				// Handle case where filter already has $or at root
				if (sqo.filter.$or) {
					new_filter.$or.push(...sqo.filter.$or);
				} else {
					// Add non-$or filters
					for (let [key, value] of Object.entries(sqo.filter)) {
						const new_object = {
							[key] : value
						};
						new_filter.$or.push(new_object);
					}
				}

				// Add new created section_id to the filter to allow see this new record.
				// Note that component tipo (rsc175) is not relevant to search component_section_id.
				new_filter.$or.push({
				    q           : section_id,
				    q_operator  : null,
				    path		: [{
						section_tipo	: self.tipo,
						component_tipo	: 'rsc175',
						model			: 'component_section_id',
						name			: 'Id'
					}],
					q_split		: false,
					type		: 'jsonb'
				});

				// Replace old filter by the new one
				sqo.filter = new_filter
			}

			// offset.
			// Set offset to current total to force navigate to the last record (the new created one)
			sqo.offset = self.total || 0;

		}else if(filter_mode==='reset_filter'){

			// reset current filter and show all records, included the new one.

			sqo.filter = null

			// reset total and force to re-calculate it
			self.total = null;
			const total = await self.get_total(sqo);

			// offset
			// Set the new offset based on the real unfiltered records count.
			sqo.offset = total - 1;

		}else{

			// legacy. using filter_by_locators to select only the new record.

			// filter_by_locators
			// Forces the auto-generated value in common.build_rqo_show based on current section_id
			sqo.filter_by_locators = null;

			// offset.
			// Set offset to zero because only one record is expected
			sqo.offset = 0;
		}

		// save pagination
		// Updates local DB pagination values to preserve consistency
		if (self.session_save===true) {
			// list pagination
			await data_manager.set_local_db_data(
				{
					id		: `${self.tipo}_list`,
					value	: {
						limit : (self.mode==='list' && self.rqo.sqo?.limit)
							? self.rqo.sqo.limit
							: 10,
						offset : 0
					}
				},
				'pagination'
			);
			// edit pagination
			await data_manager.set_local_db_data(
				{
					id		: `${self.tipo}_edit`,
					value	: {
						limit	: 1,
						offset	: sqo.offset
					}
				},
				'pagination'
			);
		}

		// launch event 'user_navigation' that page.js is watching in init events subscriptions
		event_manager.publish('user_navigation', {
			source	: source,
			sqo		: sqo
		});


		return true

	} catch (error) {
		console.error('Error navigating to new section:', error);
		throw error;
	}
}//end navigate_to_new_section



/**
* CHANGE_MODE
* Transitions the section between render modes (e.g. list → edit or edit → list)
* or between view variants (e.g. default → graph) without a full page reload.
*
* Algorithm:
*   1. Resolve the target mode and view from options (with sensible fallbacks).
*   2. Capture `self.node` as `old_node` — this is the DOM anchor point.
*   3. Patch `current_context.mode` and `.view` to the new values.
*   4. Call `get_instance` with the new mode to get (or create) the target instance.
*   5. Wrap the build + render of the new instance in `ui.load_item_with_spinner`
*      so the user sees a spinner in place of the old content while data loads.
*   6. After rendering, destroy `self` (this instance) to clean up event subscriptions
*      and child instances.
*   7. Return the new instance immediately (before its build/render completes) so
*      the caller can reference it if needed.
*
* (!) The destroy call inside the spinner callback runs asynchronously after this
* method returns. Callers must not attempt to use `self` after calling change_mode.
*
* @param {Object} options - Mode-change options
* @param {string} [options.mode] - Target render mode; when omitted, toggles between
*   'list' and 'edit'
* @param {boolean} [options.autoload=true] - Whether the new instance should fetch
*   data from the API during build
* @param {string|null} [options.view=null] - Target view variant; null keeps the
*   current view
* @returns {Promise<Object|null>} The new section instance (already registered in the
*   instance map); null if `self.node` does not exist
*/
section.prototype.change_mode = async function(options) {

	const self = this

	// options vars
		// mode check. When mode is undefined, fallback to 'list'. From 'list', change to 'edit'
		const mode = (options.mode)
			? options.mode
			: self.mode==='list' ? 'edit' : 'list'
		const autoload = (typeof options.autoload!=='undefined')
			? options.autoload
			: true
		const view = options.view ?? null

	// short vars
		const current_context	= self.context
		const section_lang		= self.section_lang
		const id_variant		= self.id_variant
		const old_node			= self.node
		if (!old_node) {
			console.warn('No old_node found!!');
			return null
		}

	// set the new view to context
		current_context.view = view
		current_context.mode = mode

	// instance
		const new_instance = await get_instance({
			model			: current_context.model,
			tipo			: current_context.tipo,
			section_tipo	: current_context.section_tipo,
			mode			: mode,
			lang			: current_context.lang,
			section_lang	: section_lang,
			type			: current_context.type,
			id_variant		: id_variant,
			caller			: self.caller || null
		})

	// load_item_with_spinner
		ui.load_item_with_spinner({
			container			: old_node,
			preserve_content	: false,
			label				: current_context.label || current_context.model,
			replace_container	: true,
			callback			: async () => {

				// build (load data)
				await new_instance.build(autoload)

				// render node
				const node = await new_instance.render()

				// destroy self instance (delete_self=true, delete_dependencies=false, remove_dom=false)
				self.destroy(
					true, // delete_self
					true, // delete_dependencies
					true // remove_dom
				)

				return node || ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'error',
					text_content	: 'Error on render element ' + new_instance.model
				})
			}
		})


	return new_instance
}//end change_mode



/**
* _TOTAL_PROMISE
* @private
* @type {Promise<number>|null}
* A private property to hold the pending promise for the total count API call.
* This prevents multiple concurrent API calls if get_total is invoked rapidly.
*/
section.prototype._total_promise = null; // Initialize this property once, likely after prototype definition



/**
* GET_TOTAL
* Asynchronously fetches the total count of records from an API
* The function is designed to handle concurrent calls safely through promise-based request deduplication,
* ensuring only one API request is made at a time for the same section instance.
*
* Two caching behaviours based on whether a custom `sqo` is supplied:
*
*   No sqo (default count):
*     - If `self.total` is already set, returns it synchronously.
*     - If a fetch is already in flight (`self._total_promise`), reuses that
*       promise to prevent duplicate API calls.
*     - On success, stores the result in `self.total` and clears `_total_promise`.
*     - On error, clears `_total_promise` so the next call retries cleanly.
*
*   Custom sqo (filtered count):
*     - Never reads or writes `self.total` — the filtered count is transient.
*     - Never deduplicates; each call gets its own fresh API request.
*
* The count rqo strips `limit`, `offset`, `select`, `order`, and
* `generated_time` from the SQO because none of these are meaningful for a
* COUNT query and including them wastes server processing time.
*
* The request is sent through a worker with up to 5 retries and a 10-second
* timeout to handle slow server responses in large activity sections.
*
* @param {Object} [sqo] - Optional custom Search Query Object for a filtered count.
*   When omitted, the instance's own `self.rqo.sqo` is used and the result is cached.
* @returns {Promise<number>} Resolves to the total record count as an integer
* @throws {Error} Re-throws any API or network error after clearing the pending promise
*/
section.prototype.get_total = async function(sqo) {

	const self = this

	// A caller-supplied sqo means a FILTERED count. It must never read or write the
	// cached section total (self.total) — that cache holds the unfiltered count.
		const use_cache = !sqo

	// already calculated case (only the default/unfiltered count is cached)
		if (use_cache && (self.total || self.total==0)) {
			return self.total
		}

	// If a promise to fetch the (default) total is already pending, reuse it for debouncing/queueing.
		if (use_cache && self._total_promise) {
			return self._total_promise;
		}

	// Create a new promise for the current API call.
	// This promise will be resolved or rejected based on the API call's outcome.
		const total_promise = (async () => {
			try {
				// Execute the actual API call to get the total.
				// API request

					// count sqo. Simplified version from current self.rqo.sqo
					const count_sqo = sqo
						? clone(sqo) // custom sqo from params
						: clone(self.rqo.sqo) // section rqo.sqo (default)
					// remove unused properties
					delete count_sqo.limit
					delete count_sqo.offset
					delete count_sqo.select
					delete count_sqo.order
					delete count_sqo.generated_time

					// source
					const source = create_source(self, null)
					// remove unused properties
					delete source.properties

					// @work in progress
					// // cache_handler. Only cache non filtered section counts
					// const cache_handler = (!count_sqo.filter || count_sqo.filter.$and?.length<1)
					// 	? {
					// 		handler	: 'localdb',
					// 		id		: 'section_cache_count_' + self.tipo
					// 	  }
					// 	  : null;

					const rqo_count	= {
						action			: 'count',
						prevent_lock	: true,
						sqo				: count_sqo,
						source			: source
					}

					const api_count_response = await data_manager.request({
						body			: rqo_count,
						use_worker		: true,
						retries			: 5, // try
						timeout			: 10 * 1000, // 10 secs waiting response (could be long in activity)
						// cache_handler	: cache_handler
					})

				// API error case
					if ( request_failed(api_count_response) ) {
						console.error('Error on count total : api_count_response:', api_count_response.error);
						return
					}

				// set result
					const total = response_data(api_count_response).total

				// only cache the default/unfiltered count on the instance
				if (use_cache) {
					self.total = total
					// Once the operation completes (successfully), clear the promise
					// so that future calls to get_total will trigger a new API request.
					self._total_promise = null;
				}

				return total; // Resolve the promise with the fetched total
			} catch (error) {
				// --- Error Handling ---
				// Log the error for debugging purposes.
				console.error("section.get_total: Error fetching total from API:", error);

				// In case of an error, clear the promise so that the next call to get_total
				// will attempt to re-fetch the total, rather than endlessly returning a rejected promise.
				if (use_cache) {
					self._total_promise = null;
				}

				// Re-throw the error so that the original caller of get_total can handle it.
				throw error;
			}
		})(); // Immediately invoke this async IIFE.

	// store the pending promise only for the default count (used for dedup above)
		if (use_cache) {
			self._total_promise = total_promise;
		}

	return total_promise; // Return the promise that was just created
}//end get_total



/**
* GOTO_LIST
* Transitions the section from edit mode back to list mode, publishing a
* 'user_navigation' event that page.js handles to swap the section instance.
*
* This method is the target of the section label click in the menu (wired in the
* render_ event handler) and can also be called programmatically.
*
* Before publishing the event the method restores the previously saved list
* pagination from the local DB so the user lands on the same page they left.
*
* The source object is built manually here (rather than via create_source) because
* the target mode is 'list', not the current edit mode.
*
* @returns {Promise<boolean>} false when called outside edit mode; true after
*   publishing the navigation event
*/
section.prototype.goto_list = async function() {

	const self = this

	// only edit mode is accepted here
		if (self.mode!=='edit') {
			return false
		}

	// MODE USING PAGE user_navigation

	const cloned_sqo = clone(self.rqo.sqo)

	// a record view's PIN names THIS record, not a result set: the list is a
	// different view, and keeping the pin would publish a one-row list. Only the
	// auto pin is dropped — a genuine result set (semantic search) is the user's
	// list and stays. Dropped by destructuring, not the delete operator.
	const { filter_by_locators: own_pin, ...unpinned_sqo } = cloned_sqo
	const sqo = is_own_record_pin(own_pin, {
		section_tipo	: self.section_tipo,
		section_id		: self.section_id
	})
		? unpinned_sqo
		: cloned_sqo

	// reset pagination from current edit sqo
		sqo.limit = null
		sqo.offset = null

	// set pagination from saved local_db_data if exists
	// Updates the rqo.sqo pagination properties with local DB values
		if (self.session_save===true) {
			const saved_pagination = await data_manager.get_local_db_data(
				`${self.tipo}_list`,
				'pagination'
			);
			if (saved_pagination) {
				sqo.limit	= saved_pagination.value?.limit
				sqo.offset	= saved_pagination.value?.offset
			}
		}

	// source
		const source = {
			action			: 'search',
			model			: self.model, // section
			tipo			: self.tipo,
			section_tipo	: self.section_tipo,
			mode			: 'list',
			lang			: self.lang
		 }

	// user_navigation event publish
		const user_navigation_options = {
			caller_id	: self.id,
			source		: source,
			sqo			: sqo  // new sqo to use in list mode
		}
		event_manager.publish('user_navigation', user_navigation_options)


	return true
}//end goto_list



/**
* BUILD_SQO_ID
* Unified way to compound sqo_id value
* This string is used as key for section session SQO
* like $_SESSION['dedalo']['config']['sqo'][$sqo_id]
*
* Currently returns the tipo unchanged, but is defined as a function to allow
* future key composition (e.g. appending a user id or workspace qualifier)
* without changing call sites.
*
* @param {string} tipo - Section tipo, e.g. 'oh1'
* @returns {string} sqo_id - The resolved session key, currently equal to tipo
*/
const build_sqo_id = function(tipo) {

	const sqo_id = tipo

	return sqo_id
}//end build_sqo_id



/**
* UPDATE_PAGINATION
* Applies a new pagination offset to the section's SQO and triggers a section
* refresh. This is the handler for the `paginator_goto_<id>` event published by
* the paginator sub-instance.
*
* The method updates both `self.rqo.sqo.offset` and, when present,
* `self.request_config_object.sqo.offset` so both the live rqo and the backing
* request_config stay in sync before the refresh reads from them.
*
* When `session_save` is true the new offset is persisted to local DB under the
* `<tipo>_<mode>` key so it survives a page reload or change_mode transition.
*
* @see section.prototype.navigate
* @param {number} offset - Zero-based record offset to navigate to
* @returns {Promise<boolean>} true after triggering navigation
*/
section.prototype.update_pagination = async function (offset) {

	const self = this

	// update section rqo sqo
		self.rqo.sqo.offset = offset
	// update section request_config_object sqo
		if (self.request_config_object?.sqo) {
			self.request_config_object.sqo.offset = offset
		}

	// get sqo after modification for proper navigation
		const sqo = clone(self.rqo.sqo)

	// save pagination
	// Updates local DB pagination values
		if (self.session_save===true) {
			await data_manager.set_local_db_data(
				{
					id		: `${self.tipo}_${self.mode}`,
					value	: {
						limit	: self.rqo.sqo.limit,
						offset	: self.rqo.sqo.offset
					}
				},
				'pagination'
			)
		}

	// navigate section rows
		self.navigate({
			sqo					: sqo,
			navigation_history	: true // bool navigation_history save
		})

	return true
}//end update_pagination



/**
* FOCUS_FIRST_INPUT
* Finds the first component in the first section_record child instance and
* activates it via `ui.component.activate`, mimicking the same method present on
* components so that callers do not need to distinguish between components and
* sections when programmatically focusing content.
*
* Used, for example, by keyboard shortcut handlers in the page to jump focus into
* the section without knowing its internal structure.
*
* @returns {boolean} true if a component was found and activated; false when
*   `ar_instances[0]` is empty or contains no instances of type 'component'
*/
section.prototype.focus_first_input = function() {

	const self = this

	const ar_instances = self.ar_instances[0]?.ar_instances || []
	const component = ar_instances.find(el => el.type==='component')
	if (component) {
		ui.component.activate(component)
		return true
	}

	return false
}//end focus_first_input



/**
* VALIDATE_MODE
* Guards against invalid or unknown mode strings before they propagate into the
* instance and cause silent render failures.
*
* The set of valid modes is: 'edit', 'list', 'list_thesaurus', 'indexation_list',
* 'solved'. ('tm' was retired — a Time Machine list is an ordinary LIST whose
* rows come from a different source, selected by sqo.mode. See
* WC-2026-08-14-tm-ddo-mode-retired.)
* 'list_thesaurus' is a server-side-only mode alias that the build method
* normalises to 'list' after the API response is received; it is listed here
* because sections can be initialised with it before build runs.
* 'indexation_list' arrives on the caller descriptor of a tool opened from an
* indexation-grid button (see the note beside the set).
*
* (!) When an unrecognised mode is passed the function currently returns it
* unchanged (with a console.error) rather than the intended default 'list'.
* The comment "It will return to the default mode in the future" signals that
* this is a transitional behaviour — do not rely on it in new code.
*
* @param {string} mode - The mode string to validate
* @returns {string} A valid mode string; currently returns the original `mode`
*   even when unrecognised (see note above)
*/
function validate_mode(mode) {

	// (!) 'indexation_list' is a REAL engine mode, not a typo: the indexation
	// grid builds its caller descriptor with it (src/core/section/indexation_grid.ts)
	// and keys real behaviour off it server-side (thumb/posterframe quality
	// instead of the 'edit' posture). It reaches this validator whenever a tool
	// opened from an indexation-grid button rebuilds its section caller — i.e.
	// on EVERY such open, where it used to raise a blocking alert() in dev mode
	// and freeze the tool window.
	const valid_modes = new Set(['edit', 'list', 'list_thesaurus', 'indexation_list', 'solved'])
	const default_mode = 'list';

	if (!mode) {
		return default_mode;
	}

	if (valid_modes.has(mode)) {
		return mode;
	}

	// Temporarily returns the given mode until this list is final.
	console.error(`Invalid mode '${mode}' received. Using it temporarily !!. Valid modes: ${[...valid_modes].join(', ')}`);
	if(SHOW_DEBUG===true) {
		alert(`Invalid mode '${mode}' received. Using it temporarily !!.\n Valid modes: ${[...valid_modes].join(', ')}`);
	}

	return mode // It will return to the default mode in the future.
}//end validate_mode


/**
* GET_ALL_TARGET_SECTIONS
* Collects all unique section tipos that are reachable from this section through
* its portal components.
*
* Walks `self.datum.context` to find every component_portal whose `section_tipo`
* matches `self.tipo`, then flattens all `sqo.section_tipo` arrays from their
* request_config entries and reduces to unique objects by `tipo` key.
*
* The result is used (for example) by delete confirmation dialogs that need to
* know which related sections should also be cleaned up.
*
* @returns {Array<Object>} Array of unique section-tipo descriptor objects, each
*   containing at minimum a `tipo` property corresponding to a reachable section tipo.
*/
section.prototype.get_all_target_sections = function() {

	const self = this

	const section_portals = self.datum.context.filter( el =>
		el.model ==='component_portal'
		&& el.section_tipo === self.tipo
	)

	const target_sections = Object.values(
		section_portals
			.flatMap(el =>
				el.request_config.flatMap(rqo =>
				rqo.sqo.section_tipo // get all objects inside the sqo `section_tipo` as target section_tipo
			)
		)
			// reduce to unique target section tipo as some components can call to the same section
			.reduce((acc, obj) => {
				if (!acc[obj.tipo]) {  // Use `tipo` as the unique key
					acc[obj.tipo] = obj;
				}
				return acc;
			}, {})
	);

	return target_sections
}//end get_all_target_sections



/**
* DELETE_CACHE
* Removes all section-level data cached in the client-side local DB (IndexedDB).
* Targets only entries whose key begins with 'section_cache_' in the 'data' table,
* leaving pagination and status entries untouched.
*
* Subscribed to the 'quit' event (user logout) and the 'change_lang' event
* (active language switch) so that stale cached data is never served after a
* user session change or locale change.
*
* @returns {Promise<void>}
*/
section.prototype.delete_cache = async function () {

	// Get all local DB data
	await data_manager.delete_local_db_data_by_prefix('data', 'section_cache_')
}//end delete_cache



// @license-end
