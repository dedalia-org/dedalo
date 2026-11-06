// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_CORE_URL */
/* eslint no-undef: "error" */



/**
* MODULE component_portal
*
* Client-side class for `component_portal` — the relational workhorse of Dédalo.
* A portal links one host record to one or more target records in another (or the same) section
* and presents those linked records as a paginated, drag-reorderable list.  It is the v7 successor
* of the old `component_autocomplete` / `component_autocomplete_hi` components.
*
* This module defines the `component_portal` constructor, all prototype methods that are
* specific to the portal (init, build, link_record, unlink_record, add_new_element,
* sort_data, sort_by_column, navigate, filter_data_by_tag_id, …), and the private
* helper `data_limit_reached`.
*
* Prototype methods are mixed in from three sources:
*   - `common`            — lifecycle: render, refresh, destroy, rqo builders.
*   - `component_common`  — change-data pipeline: save, change_value, update_datum, …
*   - Per-mode render classes (`render_edit_component_portal`, `render_list_component_portal`,
*     `render_search_component_portal`) — view dispatch.
*
* Data shape stored in `self.data.entries`: an array of locator objects, e.g.
*   { id, type, section_tipo, section_id, from_component_tipo }
*
* Event bus tokens used by this module (all stored in `self.events_tokens` for cleanup):
*   `initiator_link_<id>`    — user selects a record from the picker modal.
*   `initiator_unlink_<id>`  — user removes a linked record from the picker modal.
*   `link_terms_<id>`        — the term picker's confirmed selection, an ARRAY of terms
*                              (tree/indexation views). The channel name is never composed
*                              here: it is `PICKER_LINK_CHANNEL_PREFIX + self.id`, owned by
*                              the ONE picker module. The retired singular `link_term_<id>`
*                              channel carried one locator per click and is gone.
*   `deactivate_component`   — portal loses focus; destroys any live autocomplete service.
*   `paginator_goto_<pid>`   — paginator emits a new offset.
*   `paginator_show_all_<pid>` — show-all button resets limit to 0.
*   `reset_paginator_<pid>`  — reset button restores the configured limit.
*
* @see docs/core/components/component_portal.md for the full specification.
* @see render_edit_component_portal.js, render_list_component_portal.js,
*      render_search_component_portal.js for per-mode DOM rendering.
*/



// imports
	import {clone,object_to_url_vars, open_window, get_section_id_from_tipo} from '../../common/js/utils/index.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {get_instance} from '../../common/js/instances.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {
		common,
		set_context_vars,
		get_columns_map,
		build_autoload,
		create_source,
		lock_rows,
		destroy_row_windows,
		destroy_unwindowed_dependencies,
		get_caller_chain_tipos,
		select_by_caller_chain,
		create_callers,
		create_search_callers
	} from '../../common/js/common.js'
	import {component_common, init_events_subscription, check_unsaved_data} from '../../component_common/js/component_common.js'
	import {DATAFRAME_TYPE} from '../../component_common/js/dataframe.js'
	import {paginator} from '../../paginator/js/paginator.js'
	import {render_edit_component_portal} from '../../component_portal/js/render_edit_component_portal.js'
	import {render_list_component_portal} from '../../component_portal/js/render_list_component_portal.js'
	import {render_search_component_portal} from '../../component_portal/js/render_search_component_portal.js'
	// the ONE picker module: its channel prefix and its wiring call. Nothing about the
	// picker (mode, channel name, publisher, selection cap) is re-declared here.
	import {PICKER_LINK_CHANNEL_PREFIX, attach_picker} from '../../area_thesaurus/js/thesaurus_picker.js'
	import {response_data, request_failed} from '../../common/js/api_error.js'
	import {max_page_limit} from '../../common/js/sqo_limit.js'
	import {can_view_sort, can_save_view_order} from '../../component_portal/js/drag_and_drop.js'



/**
* COMPONENT_PORTAL
* Constructor for the portal component, which stores and manages ordered arrays of
* locators that point at records in target sections.
*
* Only declares the property skeleton; all meaningful values are set by `init()` and
* `build()`.  Prototype methods from `common`, `component_common`, and the three
* per-mode render classes are mixed in below the constructor.
*
* Key properties (set during lifecycle):
*   @var {string|null} id                    - Unique instance identifier (from common.init).
*   @var {string|null} model                 - Class name, always 'component_portal'.
*   @var {string|null} tipo                  - Ontology tipo of this component, e.g. 'oh24'.
*   @var {string|null} section_tipo          - Ontology tipo of the host section, e.g. 'oh1'.
*   @var {string|number|null} section_id     - Record id within the host section.
*   @var {string|null} mode                  - Render mode: 'edit'|'list'|'search'.
*   @var {string|null} lang                  - Active language tag, always 'lg-nolan' for portals
*                                              (portals are non-translatable).
*   @var {string|null} section_lang          - Language of the parent section UI.
*   @var {string|null} column_id             - Column instance id when rendered as a list column.
*   @var {*|null} parent                     - Ontology parent tipo of this component node.
*   @var {HTMLElement|null} node             - Root DOM element, populated by render().
*   @var {object|null} modal                 - Reference to the modal instance that hosts this
*                                              portal, if opened in a picker modal; null otherwise.
*   @var {object|null} caller               - Parent instance (section, tool, etc.) that owns
*                                              this portal instance.
*   @var {object|null} caller_dataframe     - The dataframe component instance that paired with
*                                              this portal (used by component_dataframe).
*   @var {boolean|null} standalone          - When true the portal owns its datum independently
*                                              rather than sharing it with the parent section.
*   @var {object|null} datum                - Full datum {data:[], context:[]} including any
*                                              sub-datums from target sections.
*   @var {object|null} context              - Server-resolved component context (properties,
*                                              tools, permissions, request_config, view, …).
*   @var {object|null} data                 - Resolved component data for the current record;
*                                              `data.entries` holds the locator array.
*   @var {number|null} total                - Total number of linked records (server-authoritative).
*   @var {object|null} paginator            - Paginator child instance; null in list/search mode.
*   @var {object|null} autocomplete         - Live service_autocomplete instance, if active.
*   @var {boolean|null} autocomplete_active - True while an autocomplete service is mounted.
*   @var {object|null} request_config_object - The `api_engine:'dedalo' + type:'main'` item
*                                              extracted from context.request_config; used to
*                                              build the RQO.
*   @var {object|null} rqo                  - The current Request Query Object sent to the API.
*   @var {boolean|null} fixed_columns_map   - False after each build; true once
*                                              rebuild_columns_map has run to prevent double
*                                              application.
*   @var {Object|null} view_order          - The TEMPORARY header-click display order
*                                              `{tipo, direction:'ASC'|'DESC'}` or null (the
*                                              stored order). Sent as the read RQO's
*                                              `sqo.view_order`; never written. View state:
*                                              kept across pagination and refresh, cleared
*                                              by clear_view_order / save_view_order.
*   @var {boolean} view_order_changing     - True while a set_view_order / save_view_order
*                                              is in flight: a second one is refused, never
*                                              run beside it (single flight).
*   @var {boolean|null} delete_diffusion_records - When true, deleting a linked record also
*                                              triggers diffusion record deletion (default true
*                                              in delete_linked_record).
*/
export const component_portal = function() {

	this.id						= null

	// element properties declare
	this.model					= null
	this.tipo					= null
	this.section_tipo			= null
	this.section_id				= null
	this.mode					= null
	this.lang					= null
	this.section_lang			= null
	this.column_id				= null
	this.parent					= null
	this.node					= null
	this.modal					= null
	this.caller					= null
	this.caller_dataframe		= null

	this.standalone				= null

	// context - data
	this.datum					= null
	this.context				= null
	this.data					= null

	// pagination
	this.total					= null
	this.paginator				= null

	// autocomplete service
	this.autocomplete			= null
	this.autocomplete_active	= null

	// rqo
	this.request_config_object	= null
	this.rqo					= null

	this.fixed_columns_map		= null

	// view_order. TEMPORARY header-click display order (see set_view_order)
	this.view_order				= null
	// view_order_changing. Single-flight guard of set_view_order / save_view_order
	this.view_order_changing	= false

	// delete_diffusion_records bool (on delete record, check this value)
	this.delete_diffusion_records = null
}//end component_portal



/**
* COMMON FUNCTIONS
* Prototype assignments that mix inherited behaviour into component_portal.
*
* Lifecycle (from common):
*   render, refresh, destroy
*
* Change-data pipeline (from component_common):
*   save, update_data_value, update_datum, change_value, set_changed_data,
*   change_mode
*
* RQO builders (from common):
*   build_rqo_show, build_rqo_search, build_rqo_choose
*
* Per-mode rendering (from the dedicated render classes):
*   list / tm  → render_list_component_portal.prototype.list
*   edit       → render_edit_component_portal.prototype.edit
*   search     → render_search_component_portal.prototype.search
*
* Note: `tm` (Time Machine) reuses the list render with limit=1 per row.
*/
// prototypes assign
	// life-cycle
	component_portal.prototype.render				= common.prototype.render
	component_portal.prototype.refresh				= common.prototype.refresh
	/**
	* DESTROY
	* The generic destroy, plus the things this component owns OUTSIDE the generic
	* cascade: its row windows + hover controllers (window_section_rows /
	* row_hover.js), and the thesaurus pane node (on document.body — it must never be
	* inside self.node) and the pane's area (deliberately not in ar_instances, or
	* refresh would destroy it on every pick). Nothing generic reaches them; this does.
	*
	* The row windows are flushed and stopped (common.js destroy_row_windows: hover
	* overlays first, then every window slot; a still-dirty instance is orphaned,
	* never destroyed; a pending editor node is logged) BEFORE the common cascade
	* destroys the rows they hold — on any teardown that reaches the rows (a full
	* destroy, or a dependencies destroy such as refresh({destroy:true})).
	*
	* @param {...*} args - forwarded verbatim to common.prototype.destroy.
	* @returns {Promise<*>} whatever the generic destroy returns.
	*/
	component_portal.prototype.destroy = async function(...args) {

		const self = this

		// (!) ONLY ON A FULL DESTROY (delete_self). refresh() calls destroy with
		// delete_self=false to clear DEPENDENCIES only, and every successful pick
		// runs refresh — so a pane torn down here on that path is a picker that
		// closes on the click that just linked a term. The pane's lifetime is the
		// COMPONENT's, not its refresh cycle.
		const delete_self = args[0]===true
		// row windows + hover controllers: flushed and stopped BEFORE the cascade
		// destroys the rows they hold. common.destroy defaults delete_self to true,
		// so a destroy() without arguments reaches the rows too.
		const delete_dependencies = args[1]===true
		if (args[0]!==false || delete_dependencies) {
			await destroy_row_windows(self)
		}
		if (delete_self) {
			if (self.thesaurus_pane_resize_observer) {
				self.thesaurus_pane_resize_observer.disconnect()
				self.thesaurus_pane_resize_observer = null
			}
			if (self.thesaurus_pane) {
				close_thesaurus_pane(self)
				self.thesaurus_pane.remove()
				self.thesaurus_pane = null
			}
			// the pane's area is owned HERE (it is deliberately not in ar_instances)
			if (self.thesaurus_area && self.thesaurus_area.status!=='destroyed') {
				await self.thesaurus_area.destroy(true, true, true)
			}
			self.thesaurus_area = null
		}

		return common.prototype.destroy.apply(self, args)
	}

	// change data
	component_portal.prototype.save					= component_common.prototype.save
	component_portal.prototype.update_data_value	= component_common.prototype.update_data_value
	component_portal.prototype.update_datum			= component_common.prototype.update_datum
	component_portal.prototype.change_value			= component_common.prototype.change_value
	component_portal.prototype.set_changed_data		= component_common.prototype.set_changed_data
	component_portal.prototype.build_rqo_show		= common.prototype.build_rqo_show
	component_portal.prototype.build_rqo_search		= common.prototype.build_rqo_search
	component_portal.prototype.build_rqo_choose		= common.prototype.build_rqo_choose

	// render
	component_portal.prototype.list					= render_list_component_portal.prototype.list
	component_portal.prototype.edit					= render_edit_component_portal.prototype.edit
	component_portal.prototype.search				= render_search_component_portal.prototype.search

	component_portal.prototype.change_mode			= component_common.prototype.change_mode



/**
* INIT
* Initializes the portal instance: seeds portal-specific properties, registers all
* event-bus subscriptions that last for the lifetime of the instance, and populates
* the `render_views` registry.
*
* Delegates base property setup (id, tipo, section_tipo, mode, lang, caller, …) to
* `component_common.prototype.init`, which in turn calls `common.prototype.init`.
* All three event tokens are pushed into `self.events_tokens` so they are cleaned
* up during `destroy()`.
*
* Event subscriptions registered here:
*   `initiator_link_<id>`   — user confirms selection in picker; calls `link_record`.
*   `initiator_unlink_<id>` — user removes a record from picker; calls `unlink_record`.
*   `link_terms_<id>`       — the term picker's confirmed selection (an ARRAY); completes
*                             every locator with the view's own metadata
*                             (tag_id / tag_component_tipo / top_locator in indexation view,
*                             nothing at all in tree view) before delegating to
*                             `link_records` — ONE save for the whole selection.
*   `deactivate_component`  — any component blur; tears down the live autocomplete
*                             service when this portal loses focus.
*
* @param {Object} options                          - Initialization options bag.
* @param {string} options.model                    - Class name, e.g. 'component_portal'.
* @param {string} options.tipo                     - Ontology tipo of this component.
* @param {string} options.section_tipo             - Ontology tipo of the host section.
* @param {string|number} options.section_id        - Host record identifier.
* @param {string} options.mode                     - Render mode: 'edit'|'list'|'search'.
* @param {string} options.lang                     - Active language tag.
* @param {object|null} [options.columns_map]       - Pre-built columns map; if supplied it is
*                                                    used as-is and rebuilt from context otherwise.
* @param {object|null} [options.caller_dataframe]  - The dataframe component that paired with
*                                                    this portal, if any.
* @param {Array|null} [options.request_config]     - Request config array used when no server
*                                                    context is available yet (first build).
* @returns {Promise<boolean>} Resolves to the result of `component_common.prototype.init`,
*                             which is `true` on success or `false` on duplicate-init guard.
*/
component_portal.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await component_common.prototype.init.call(self, options);

	// autocomplete. set default values of service autocomplete
		self.autocomplete			= null
		self.autocomplete_active	= false

	// columns
		self.columns_map			= options.columns_map
		self.add_component_info		= false

	// caller_dataframe
		self.caller_dataframe		= options.caller_dataframe

	// request_config
		self.request_config			= options.request_config || null

	// events subscribe

		// initiator_link. Observes user click over list record_
			const initiator_link_handler = async (locator) => {
				// debug
					if(SHOW_DEBUG===true) {
						console.log('-> event fn_initiator_link locator:', locator);
					}
				// add locator selected
					const result = await self.link_record(locator)
					if (result===false) {
						return
					}
				// modal close
					if (self.modal && locator.close_modal !== false) {
						self.modal.close()
					}
			}
			self.events_tokens.push(
				event_manager.subscribe(`initiator_link_${self.id}`, initiator_link_handler)
			)

		// initiator_unlink. Observes user click over list record to remove from portal
			const initiator_unlink_handler = async (locator) => {
				// debug
					if (SHOW_DEBUG===true) {
						console.log('-> event fn_initiator_unlink locator:', locator);
					}

					if (!locator.id) {
						console.warn('Value to unlink not found in current entries');
						return
					}

				// remove locator selected
					const result = await self.unlink_record(locator)
					if (result===false) {
						return
					}
				// modal close
					if (self.modal && locator.close_modal !== false) {
						self.modal.close()
					}
			}
			self.events_tokens.push(
				event_manager.subscribe(`initiator_unlink_${self.id}`, initiator_unlink_handler)
			)

		// link_terms. Observes the term picker's CONFIRMED selection
		// Published by the ONE publisher (thesaurus_picker.publish_link_terms) on
		// `PICKER_LINK_CHANNEL_PREFIX + self.id`, always with an ARRAY payload — a single
		// pick is the length-1 case, so there is no second code path for it.
		// The handler completes every locator with the view's own metadata and hands the
		// whole selection to link_records(): ONE save, so the server evaluates dedup and
		// the selection cap over the batch instead of over N independent requests.
			const link_terms_handler = async (terms) => {

				// payload. Always a non-empty array
					if (!Array.isArray(terms) || terms.length<1) {
						console.error(
							'(!) [component_portal.link_terms] refused: the pick payload must be a non-empty ARRAY.'
							+ ' A publisher still sending the retired singular locator must be migrated to'
							+ ' thesaurus_picker.publish_link_terms. Received:',
							terms
						);
						return
					}
					// never mutate the publisher's payload: the picker keeps its selection
					// objects alive (chips, already-linked marks) after the confirm
					const locators = terms.map(term => clone(term))

				switch (self.view) {
					case 'indexation': {
						// The tag decision is taken ONCE for the whole selection: it describes
						// where the terms are being indexed, not which term was clicked.

						// empty tag_id is allowed too
						// add tag_id. Note that 'self.active_tag' is an object with 3 properties (caller, text_editor and tag)
							const tag_id = self.active_tag?.tag
								? self.active_tag.tag.tag_id || null
								: null
							if (!tag_id) {
								// No tag is selected yet; confirm whether to index the whole record
								// (i.e. tag the relation at record level rather than at an inline tag).
								if (!confirm(get_label.no_tag_selected ||
									'No tag selected. If you continue, the entire record will be indexed.')) {
									return
								}
							}

						// tag_component_tipo
						// Mandatory for indexation portals: identifies which text component
						// carries the inline tag.  Defined in properties->config_relation.
							const tag_component_tipo = self.context.properties?.config_relation?.tag_component_tipo
							if (!tag_component_tipo) {
								console.error('tag_component_tipo is not defined into component properties->config_relation . This is mandatory in v6', self.context.properties);
								return
							}

						// top_locator add
						// top_locator is injected by tool_indexation onto self.caller; it carries
						// the section locator of the record currently open in the indexation tool.
							const top_locator = self.caller.top_locator // property from tool_indexation
							// check active tag is already set
							if (!top_locator) {
								alert("Error. No top_locator exists");
								return
							}

						// apply the same decision to every picked term
							for (const locator of locators) {
								if (tag_id) {
									// overwrite/set tag_id
									locator.tag_id = tag_id
								}
								locator.tag_component_tipo = tag_component_tipo
								Object.assign(locator, top_locator)
							}
						break;
					}
					case 'tree':
						// (!) NO `type` IS STAMPED HERE, deliberately.
						// The server owns the relation type: save.ts fills it only when absent,
						// from properties.config_relation.relation_type and otherwise from the
						// MODEL's descriptor default — which is not dd151 for the models this
						// view serves (children dd48, parent dd47, index dd96, related dd89,
						// model dd98, dataframe dd490). The old client-side dd151 stamp wrote
						// wrong-typed rows for every one of them and broke the server's dedup
						// key [section_id, section_tipo, type, tag_id] against correctly-typed
						// existing rows. A tree pick carries the address and nothing else.
						break;

					default: {
						// NAMED REFUSAL. Only the two views that know how to complete a picked
						// locator may link one. Everything else used to console.warn and link an
						// untyped, unenriched locator anyway — a silent scope widening: an
						// indexation locator without tag_component_tipo/top_locator persists as a
						// relation nothing can read back. A view that wants to accept picks
						// declares its own case here.
						console.error(
							`(!) [component_portal.link_terms] refused: view "${self.view}" declares no term-pick`
							+ ` handler, so the selection cannot be completed. component: ${self.tipo}`,
							locators
						);
						// the user clicked; the refusal is told to them too, never a dead click.
						// (!) No English fallback literal: a missing catalog key renders AS the key
						// (greppable, obviously wrong) instead of outliving the catalog entry.
						event_manager.publish('notification', {
							msg			: get_label.picker_view_not_supported || 'picker_view_not_supported',
							type		: 'error',
							remove_time	: 10000
						})
						return
					}
				}

				// debug
					if(SHOW_DEBUG===true) {
						console.log("-->> link_terms_handler. Locators to add:", locators);
					}

				// REPLACE, for a single-valued caller. `data_limit:1` means "one value", so a
				// new pick supersedes the stored one instead of being refused by the write
				// path's cap. This belongs HERE and not in the picker: the component owns its
				// value; the picker only reports what the operator chose.
				//
				// (!) THE REPLACE IS ONE SAVE NOW, AND THE ORDERING IS THE WHOLE FIX.
				// Until 2026-08-30 this branch called `delete_locator` on every stored
				// locator FIRST, never read the answer, and only then called `link_records`.
				// A destructive step preceded a step that can fail: when the pick was
				// refused (non-selectable term, target outside the caller's declared
				// sections, unreadable target, expired session) the curated relation was
				// ALREADY GONE from the record, the single-valued field was left EMPTY, and
				// the alert below named only the pick refusal — never the destruction. The
				// stored locators now travel to `link_records` as `replace_entries` and are
				// removed inside the SAME save as the insert, so there is no window in which
				// the component holds nothing, and `link_records` reports (and tries to undo)
				// the one residual case it cannot prevent. See its `replace_entries` doc.
					const replace_entries = []
					const data_limit = self.context.properties?.data_limit
					if (data_limit===1) {
						// `self.data` is an OBJECT and `entries` is the locator
						// array — NOT `data[0].value`, which is undefined on every
						// real component and once made this branch a silent no-op:
						// it superseded nothing, the server then refused the pick as
						// over-cap, and a single-valued picker could never change
						// its value at all.
						const current = self.data?.entries
						if (Array.isArray(current) && current.length>0) {
							replace_entries.push(...current)
						}
					}

				// add the pick(s) in ONE save
					const outcome = await self.link_records(locators, {
						// (!) the client data_limit guard is NOT applied to a picker selection.
						// The picker was bounded by the server-resolved `remaining` before the
						// user could even select, and the write path re-resolves the cap inside
						// its transaction. Alerting here would make the client a second, weaker
						// authority over the same rule.
						enforce_client_data_limit : false,
						// the stored value this pick supersedes, removed in the SAME save
						replace_entries : replace_entries
					})
					if (outcome.refused.length>0) {
						// (!) alert() kept from the single-pick path: the user committed to these
						// picks and must be told which ones did not land, and why.
						alert(
							(get_label.error || 'Error') + ':\n'
							+ outcome.refused.map(item => item.locator
								? `${item.reason} — ${item.locator.section_tipo}_${item.locator.section_id} ${item.locator.label || ''}`
								: item.reason
							).join('\n')
						);
					}
			}
			self.events_tokens.push(
				event_manager.subscribe(PICKER_LINK_CHANNEL_PREFIX + self.id, link_terms_handler)
			)

		// deactivate_component. Observes current component deactivation event
		// The global 'deactivate_component' event fires whenever any component loses focus.
		// We check if it is this portal's own id before tearing down the autocomplete service,
		// so that sibling portals on the same page are unaffected.
			const deactivate_component_handler = (component) => {
				if (component.id===self.id) {
					if(SHOW_DEBUG===true) {
						console.log('self.autocomplete_active:', self.autocomplete_active);
					}
					// the thesaurus pane closes with the component's blur: it is a
					// picker FOR this component, and an open picker on a component the
					// operator has left is a stale surface over the rest of the form
					// ...unless the blur is caused by activating a component INSIDE the
					// pane (search field, tree tool button): ui.component.activate
					// deactivates the previous one BEFORE fixing page_globals.component_active,
					// so the check is deferred until the new one is in place.
					if (self.thesaurus_pane && !self.thesaurus_pane.classList.contains('hide')) {
						setTimeout(() => {
							const active_node = page_globals.component_active?.node
							if (active_node && self.thesaurus_pane?.contains(active_node)) {
								return
							}
							close_thesaurus_pane(self)
						}, 0)
					}
					if(self.autocomplete_active===true){
						// Defer to the idle callback so the autocomplete can finish any
						// in-flight selection before it is torn down.
						dd_request_idle_callback(
							() => {
								self.autocomplete.destroy(
									true, // bool delete_self
									true, // bool delete_dependencies
									true // bool remove_dom
								)
								self.autocomplete_active	= false
								self.autocomplete			= null
							}
						)
					}
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('deactivate_component', deactivate_component_handler)
			)

	// render_views
	// Maps {view, mode} pairs to the render module name (and optional dynamic-import path).
	// Used by common.render() to dispatch the correct render function.
	// Tools or external components may push additional entries here at runtime to add custom views.
	// Sample structure for a dynamically-added entry:
	// {
	// 		view	: 'default',
	// 		mode	: 'edit',
	// 		render	: 'view_default_edit_portal'
	// 		path 	: './view_default_edit_portal.js'
	// }
	// An entry may also DECLARE the toolbar the view needs, as data:
	// 		show_interface : { button_tree : true, button_add : false }
	// build() composes it (see compose_show_interface); the view module itself must not
	// write self.show_interface at render time — that is how the two writers used to
	// resolve by accident, whichever ran last.
		self.render_views = [
			{
				view	: 'text',
				mode	: 'edit',
				render	: 'view_text_list_portal'
			},
			{
				view	: 'line',
				mode	: 'edit',
				render	: 'view_line_edit_portal'
			},
			{
				view	: 'tree',
				mode	: 'edit',
				render	: 'view_tree_edit_portal',
				// The tree view's toolbar, DECLARED (it was written inside
				// view_tree_edit_portal.render, after build had already composed
				// show_interface). The term picker is the way to attach terms in this
				// view, so it is the one button turned on.
				// (!) `show_autocomplete` is absent ON PURPOSE: a picker view ADDS an
				// input path and removes none, so a portal that declares an autocomplete
				// (e.g. oh115's properties.source.mode 'autocomplete') keeps it.
				// compose_show_interface REFUSES a view that tries to declare it.
				show_interface : {
					button_tree			: true,
					button_add			: false,
					button_link			: false,
					button_list			: false,
					button_fullscreen	: false
				}
			},
			{
				view	: 'mosaic',
				mode	: 'edit',
				render	: 'view_mosaic_edit_portal'
			},
			{
				view	: 'indexation',
				mode	: 'edit',
				render	: 'view_indexation_edit_portal'
			},
			{
				view	: 'content',
				mode	: 'edit',
				render	: 'view_content_edit_portal'
			},
			{
				view	: 'default',
				mode	: 'edit',
				render	: 'view_default_edit_portal',
				path 	: './view_default_edit_portal.js'
			},
			{
				view	: 'line',
				mode	: 'list',
				render	: 'view_line_list_portal'
			},
			{
				view	: 'mini',
				mode	: 'list',
				render	: 'view_mini_portal'
			},
			{
				view	: 'text',
				mode	: 'list',
				render	: 'view_text_list_portal'
			},
			{
				view	: 'default',
				mode	: 'list',
				render	: 'view_default_list_portal'
			}
		]


	return common_init
}//end init



/**
* SENDS_OWN_SHOW
* Whether this portal's own reads carry its context's show / search ddo_map
* (`add_show`, owner decision (a) — consistent paging) — whenever its context
* may have been INJECTED: a NESTED instance (a component stands above it in the
* caller chain, get_component_ancestors), or a top-level one whose SECTION's map
* declares its children (section_injects_children — the section is the caller
* of every top-level column, server relations/element_node.ts rootNodeFor).
* Only on get_data, only in the cell modes ('edit', 'list'), never for a
* component_dataframe (paired to its main item, read through its own door).
*
*   tch1 edit → tch197 (top level, own map)               → false (its own config)
*   test3 list [test80, test52<test80] → test80 (top)     → true  (section-injected)
*   tch197 → row → rsc1400 (nested, list)                 → true
*
* The server merges the sent maps onto the element's resolved config and
* replaces ONLY show / search (relations/element_node.ts mergeComponentStageOne):
* hide, choose, the other engines and the sqo (a fresh fixed_filter) stay its own.
*
* @param {Object} self - The component_portal instance
* @param {string} action - 'get_data' | 'resolve_data'
* @returns {boolean}
*/
export const sends_own_show = function(self, action) {

	if (action!=='get_data' || self.model==='component_dataframe') {
		return false
	}
	if (self.mode!=='edit' && self.mode!=='list') {
		return false
	}


	// a show map never travels without the chain that verifies it: whenever
	// create_callers has no chain to send (a top-level portal its section does
	// not inject into, a dataframe ancestry, a chain the server could not accept),
	// the read resolves the portal's own config. create_callers returns a chain
	// exactly when the portal is nested or section-injected (section_injects_children).
	return create_callers(self)!==null
}//end sends_own_show



/**
* ATTACH_SHOW_MAPS
* Put the context's show / search ddo_map on a nested portal's rqo (add_show,
* owner decision (a)). The server copies ONLY `ddo_map` from `show` and
* `search` (request_config/from_rqo.ts — never `sqo_config`, never choose /
* hide), so only the maps travel: `rqo.show = {ddo_map}`, plus
* `rqo.search = {ddo_map}` when the context declares a search map. Clones —
* the context's maps are never shared with the wire object.
*
* @param {Object} rqo - The rqo build_rqo_show returned (mutated)
* @param {Object|null} request_config_object - The main dedalo request_config item
* @returns {Object} rqo
*/
export const attach_show_maps = function(rqo, request_config_object) {

	const show_map		= request_config_object?.show?.ddo_map
	const search_map	= request_config_object?.search?.ddo_map

	rqo.show = {
		ddo_map : Array.isArray(show_map) ? clone(show_map) : []
	}
	if (Array.isArray(search_map)) {
		rqo.search = {
			ddo_map : clone(search_map)
		}
	}else{
		Reflect.deleteProperty(rqo, 'search')
	}


	return rqo
}//end attach_show_maps



/**
* MERGE_FIXED_FILTER_SQO
* A refresh of a portal whose config carries a `fixed_filter` (resolved server
* side from live record data, e.g. an observed component value) takes the
* FRESH sqo of each request_config item — matched by api_engine + type — and
* NOTHING else: the context is write-once, so show / search / choose / hide stay
* what the caller injected (tch197's [rsc86 surname, rsc85 name] must not flip
* back to rsc1400's own [rsc85, rsc86] on refresh — plan E11; the old code
* replaced the whole request_config). An item the fresh config has but the
* context lacks is not added (the context's shape is the caller's).
*
* @param {Object} context - self.context (its request_config items mutated in place)
* @param {Array<Object>} fresh_request_config - The refreshed context's request_config
* @returns {boolean} true when at least one sqo was taken
*/
export const merge_fixed_filter_sqo = function(context, fresh_request_config) {

	const current_request_config = context?.request_config
	if (!Array.isArray(current_request_config) || !Array.isArray(fresh_request_config)) {
		return false
	}

	let merged = false
	for (const fresh_item of fresh_request_config) {
		if (!fresh_item || !fresh_item.sqo) {
			continue
		}
		const current_item = current_request_config.find(el =>
			el.api_engine===fresh_item.api_engine && el.type===fresh_item.type
		)
		if (!current_item) {
			continue
		}
		current_item.sqo = clone(fresh_item.sqo)
		merged = true
	}


	return merged
}//end merge_fixed_filter_sqo



/**
* BUILD
* Loads server data (context + data) when `autoload=true`, then resolves all
* instance state that depends on context: RQO, columns_map, paginator, show_interface
* flags, separators, and data_limit guards.
*
* Called once after `init()` and again on every `refresh()` cycle.  Follows the
* Dédalo lifecycle contract: transitions `self.status` from 'building' → 'built'.
*
* When `autoload=true`:
*  1. Calls `build_autoload()` to fetch context + data from the API in one round-trip.
*  2. Preserves an existing `self.context` (context may have been customised by a ddo_map
*     override injected by section_record.js, which must not be overwritten by the raw
*     server context).
*  3. Calls `self.destroy(false, true, false)` to tear down child instances before
*     rebuilding, so stale sub-component nodes are not left in the DOM.
*  4. Sets `self.data` from the API result for the matching tipo+section_id.
*  5. Updates `self.datum` (shared datum) unless the portal is standalone.
*  6. Synchronises `self.rqo.sqo.limit` from the updated request_config (the server
*     may have adjusted the limit at resolve time).
*
* After (optional) autoload, regardless of `autoload` flag:
*  - `generate_rqo()` builds or reuses `self.rqo`.
*  - `set_context_vars()` copies shorthand properties from context to self.
*  - `init_events_subscription()` wires observe/observable hooks (idempotent; only
*    fires once per instance).
*  - Paginator is created (edit/tm mode only) or updated if already exists.
*  - `show_interface` is composed ONCE by `compose_show_interface()` — multi-target
*    constraints, then the render_views entry's declared toolbar, then the
*    source.mode / tool-caller constraints. No view module writes it afterwards.
*  - `self.add_component_info` is set from the ddo_map `value_with_parents` marker, used
*    by service_autocomplete to decide whether to request ddinfo for autocomplete entries.
*
* @param {boolean} [autoload=false] - When true, fetches context+data from the API.
*                                     Pass false when the caller already injected
*                                     `self.context` and `self.data` (e.g. section_record
*                                     embedding context, or refresh with tmp_api_response).
* @returns {Promise<boolean>} Resolves to `true` when build completes successfully.
*                             Returns `false` if the API call fails or returns no context.
*/
component_portal.prototype.build = async function(autoload=false) {
	// const t0 = performance.now()

	const self = this

	// status update
		self.status = 'building'

	// self.datum. On building, if datum is not created, creation is needed
		self.datum = self.datum || {
			data	: [],
			context	: []
		}
		self.data = self.data || {}
		// changed_data. Set as empty array always
		self.data.changed_data = []

	// rqo
	// generate_rqo is defined as an inner async function and called twice:
	// once here (pre-autoload, to build the initial RQO) and again after autoload
	// (to regenerate the RQO with the refreshed context and correct limit).
		const generate_rqo = async function() {

			if (!self.context) {
				// No context yet (first build before API response): read from options.request_config.
				self.request_config_object = self.request_config
					? self.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
					: {}
			}else{
				// Context is available: use the server-resolved request_config from context.
				self.request_config_object	= self.context?.request_config
					? self.context.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
					: {}
			}

			// rqo build
			// In search mode the portal acts as a filter input; it sends 'resolve_data'
			// with the current locator entries as the source value so the search engine
			// can identify matching records.
			// add_show — CONSISTENT PAGING (owner decision (a), nested-ddo_map plan): a
			// NESTED portal's context came from its caller, which may have injected
			// its children (tch197 declares rsc1400's [rsc86 surname, rsc85 name] while
			// rsc1400's own map is [rsc85, rsc86]). Page 1 arrived inside the caller's
			// read; without its show on page 2 the server would resolve the portal's
			// OWN map and the rows would no longer fit the (write-once) columns. So a
			// nested instance sends the show (and search) ddo_map of its context with
			// every own read; the server validates it (stage 1, request_config/
			// from_rqo.ts) under the caller chain create_callers sends beside it. So
			// does a top-level portal whose SECTION's map injected its children
			// (sends_own_show); any other top-level portal resolves its own config
			// server side, as before.
			const action	= (self.mode==='search') ? 'resolve_data' : 'get_data'
			// (only a context that HAS a show map is sent: an instance built without
			// one must never send an empty show, which the server would honour as
			// "no columns")
			const add_show	= sends_own_show(self, action)
				&& Array.isArray(self.request_config_object?.show?.ddo_map)
			if (!self.rqo) {
				self.rqo = await self.build_rqo_show(
					self.request_config_object, // object request_config_object
					action,  // string action like 'get_data' or 'resolve_data'
					add_show // bool add_show
				)
				if (add_show===true) {
					attach_show_maps(self.rqo, self.request_config_object)
				}
			}
			if(self.mode==='search') {
				// Inject current entries as the RQO source value so the server knows
				// which records to resolve for the search filter.
				self.rqo.source.value = self.data.entries || []
			}
			// view_order. The instance property is the one source: every read
			// carries it (or none), whatever rebuilt the rqo
			sync_view_order_sqo(self)
		}
		await generate_rqo()

	// debug check
		// if(SHOW_DEBUG===true) {
		// 	// console.log("portal generate_rqo 1 self.request_config_object:", clone(self.request_config_object) );
		// 	// console.log("portal generate_rqo 1 self.rqo:", clone(self.rqo) );
		// 	const ar_used = []
		// 	for(const element of self.datum.data) {

		// 		if (element.matrix_id) { continue; } // skip verification in matrix data

		// 		const index = ar_used.findIndex(item => item.tipo===element.tipo &&
		// 												item.section_tipo===element.section_tipo &&
		// 												item.section_id==element.section_id &&
		// 												item.from_component_tipo===element.from_component_tipo &&
		// 												item.parent_section_id==element.parent_section_id &&
		// 												item.row_section_id==element.row_section_id
		// 												// && (item.matrix_id && item.matrix_id==element.matrix_id)
		// 												// && (item.tag_id && item.tag_id==element.tag_id)
		// 												)
		// 		if (index!==-1) {
		// 			console.error("PORTAL ERROR. self.datum.data contains duplicated elements:", ar_used[index]);
		// 		}else{
		// 			ar_used.push(element)
		// 		}
		// 	}
		// }

	// load from DDBB
		if (autoload===true) {

			// view_order vs an injected save echo. A save echo (link / unlink / add /
			// sort_data … refresh with tmp_api_response) is answered in the STORED order:
			// a save request carries no sqo, so no view order. Under an active view order
			// the echo is dropped and the rqo (stamped by sync_view_order_sqo above) is
			// read instead — the rows, the header arrows and the order indicator always
			// show the order the rows were READ in. One gate for every echo path.
				if (self.tmp_api_response && echo_hides_view_order(self)) {
					delete self.tmp_api_response
				}

			// build_autoload
			// Unified loader: sends the RQO to the API, handles login-expired and
			// network-error cases, and returns the raw api_response or null/false.
				const api_response = await build_autoload(self)

				// server: wrong response
				if (!api_response) {
					return false
				}
				// server: bad build context
				const datum = response_data(api_response)
				if(!datum.context.length){
					console.error("Error!!!!, component without context:", api_response);
					return false
				}

			// destroy dependencies
			// Tear down child instances before re-building so stale nodes are removed.
			// The portal itself stays alive and its DOM is kept (no flash: the upcoming
			// render repopulates it). The rows a record window holds are NOT torn down
			// here: its next content render retires them, adopting or flushing first.
				await destroy_unwindowed_dependencies(self)

			// set Context
				// Context is preserved when it was already set before this build cycle.
				// Reason: a ddo_map override (e.g. oh27 defines a custom mode/view/children_view
				// for rsc368) is injected by section_record.js into self.context *before* the
				// first build.  The raw API context for rsc368 uses the default config, so if we
				// overwrote self.context here we would lose the ddo_map customisation on every
				// refresh.  Context is therefore treated as write-once from the outside.
				// own_chain — the portal's own ancestry, for a response that split its key
				// per parent occurrence (owner decision (b), `caller_chain`): the entry /
				// item of THIS occurrence is taken (select_by_caller_chain)
				const own_chain = () => get_caller_chain_tipos(self)
				if(!self.context){
					const context = select_by_caller_chain(
						datum.context.filter(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo),
						own_chain
					)
					if (!context) {
						console.error("context not found in api_response:", api_response);
					}else{
						self.context = context
					}
				}else{
					// fixed_filter. It is resolved server side from live record data (e.g. observed component value),
					// so on refresh take the fresh SQO — and ONLY the sqo: the show / search /
					// choose / hide maps stay the write-once context's (merge_fixed_filter_sqo)
					const context = select_by_caller_chain(
						datum.context.filter(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo),
						own_chain
					)
					if (context?.request_config?.some(el => el.sqo?.fixed_filter)) {
						merge_fixed_filter_sqo(self.context, context.request_config)
					}
				}

			// set Data
			// Match by tipo + section_tipo + section_id (string-coerced), per occurrence.
				const data = select_by_caller_chain(
					datum.data.filter(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo && String(el.section_id) === String(self.section_id)),
					own_chain
				)
				if(!data){
					console.warn("data not found in api_response:",api_response);
				}
				self.data = data || {}

			// Update datum when the component is not standalone, it's dependent of section or others with common datum
			// In non-standalone mode, update_datum merges this response into the shared
			// datum that the parent section instance also holds, so sub-component
			// instances that share the same datum are all kept in sync.
				if(!self.standalone){
					await self.update_datum(datum)
				}else{
					// Standalone portals own their datum independently; assign directly.
					self.datum.context	= datum.context
					self.datum.data		= datum.data
				}

			// // context. update instance properties from context (type, label, tools, fields_separator, permissions)
			// 	self.context		= datum.context.find(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo)
			// 	self.datum.context	= datum.context

			// force re-assign self.total
			// Reset so that the post-build logic reads total from the fresh data.pagination.
				self.total = null

			// rqo regenerate
			// Regenerate now that self.context is populated with the freshly-loaded context.
				await generate_rqo()
				// console.log("portal generate_rqo 2 self.rqo:",self.rqo);

			// update rqo.sqo.limit. Note that it may have been updated from the API response
			// The server may have clamped or overridden the limit in the resolved request_config.
			// Paginator takes limit from: self.rqo.sqo.limit
			// (!) Two possible locations for the limit: sqo.limit (newer) and show.sqo_config.limit (legacy).
				const request_config_item = self.context.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
				if (request_config_item) {
					// Updated self.rqo.sqo.limit. Try sqo and show.sqo_config
					if (request_config_item.sqo &&
						(request_config_item.sqo.limit || request_config_item.sqo.limit===0)) {

						self.rqo.sqo.limit = request_config_item.sqo.limit
					}
					else if (request_config_item.show?.sqo_config &&
							(request_config_item.show.sqo_config.limit || request_config_item.show.sqo_config.limit===0)) {

						self.rqo.sqo.limit = request_config_item.show.sqo_config.limit
					}
				}
		}//end if (autoload===true)


	// update instance properties from context
	// Copies shorthand properties from the resolved context to self
	// (e.g. self.label, self.permissions, self.view, self.type, …).
		set_context_vars(self, self.context)

	// subscribe to the observer events (important: only once)
	// Registers any observe/observable wiring declared in the ontology properties.
	// The function is idempotent: it guards against double-subscription internally.
		init_events_subscription(self)

	// mode cases
		if (self.mode==='edit') {
			// Pagination state is only meaningful in edit mode.
			// In list and search modes the paginator is not shown — and a Time Machine
			// cell IS a list cell now (WC-2026-08-14-tm-ddo-mode-retired), so it takes
			// the list branch, which is what a one-row history cell should do anyway.

			// pagination. update element pagination vars when are used
			// Sync local offset/total from the data.pagination object that the
			// API returns together with the entries array.
				if (self.data.pagination && !self.total) {
					self.total			= self.data.pagination.total
					self.rqo.sqo.offset	= self.data.pagination.offset
					self.rqo.sqo.total	= self.data.pagination.total
					// The page size the server actually used (a section ddo_map limit can
					// differ from the context request_config): the paginator divides by it.
					if (typeof self.data.pagination.limit==='number') {
						self.rqo.sqo.limit = self.data.pagination.limit
					}
				}

			// paginator
				if (!self.paginator) {

					// create new one
					// 'micro' mode renders a compact paginator bar (prev/next/page count).
					self.paginator = new paginator()
					self.paginator.init({
						caller	: self,
						mode	: 'micro'
					})
					await self.paginator.build()

					// paginator_goto_ event
					// The paginator publishes this event when the user clicks a page number or
					// prev/next.  The callback updates self.rqo.sqo.offset then calls navigate().
						const paginator_goto_handler = function(offset) {
							// navigate
							self.navigate({
								callback : () => {
									self.rqo.sqo.offset = offset
								}
							})
						}
						self.events_tokens.push(
							event_manager.subscribe(`paginator_goto_${self.paginator.id}`, paginator_goto_handler)
						)


					// paginator_show_all_
					// Published when the user clicks the "show all" button.
					// "All" is the SERVER's client ceiling (page_globals
					// dedalo_search_client_max_limit, WC-2026-09-04-client-limit-bound):
					// the client never sends 0 — the server read 0 as the same ceiling
					// and clamped in silence (DEC-07), so a portal above the ceiling
					// was truncated with nothing to say so. Sending the bound the
					// server applies keeps the paginator's total honest about it.
						const paginator_show_all_handler = function() {
							// navigate
							self.navigate({
								callback : async () => {
									// rqo and request_config_object set offset and limit
									self.rqo.sqo.offset	= self.request_config_object.sqo.offset	= 0
									self.rqo.sqo.limit	= self.request_config_object.sqo.limit	= max_page_limit()
								}
							})
						}
						self.events_tokens.push(
							event_manager.subscribe('paginator_show_all_'+self.paginator.id, paginator_show_all_handler)
						)

					// reset_paginator_
					// Published by the paginator when the user resets from "show all" back to
					// paged mode.  `limit` is the page size to restore.
						const reset_paginator_handler = function(limit) {
							// navigate
							self.navigate({
								callback : async () => {
									// rqo and request_config_object set offset and limit
									self.rqo.sqo.offset	= self.request_config_object.sqo.offset	= 0
									self.rqo.sqo.limit	= self.request_config_object.sqo.limit	= limit
								}
							})
						}
						self.events_tokens.push(
							event_manager.subscribe('reset_paginator_'+self.paginator.id, reset_paginator_handler)
						)

				}else{
					// Paginator already exists (subsequent refresh): sync its state with the
					// new offset and total without fully rebuilding it.
					self.paginator.offset = self.rqo.sqo.offset
					self.paginator.total  = self.total
					// self.paginator.refresh()
					// await self.paginator.build()
					// self.paginator.render()
				}

		}else if(self.mode==='search') {

			// active / prepare the autocomplete in search mode
			// (placeholder for future search-mode autocomplete setup if needed)

		}// end if(self.mode==="edit")

	// check self.context.request_config
	// A missing request_config is a fatal misconfiguration: the portal cannot build
	// its RQO or render anything useful without it.
		if (!self.context.request_config) {
			console.error('Error. context.request_config not found. self:', self);
			throw 'Error';
		}

	// target_section
	// The ontology tipo(s) of the target section(s) this portal links to.
	// May be a single string or an array of strings (multi-target portal).
		self.target_section = self.request_config_object && self.request_config_object.sqo
			? self.request_config_object.sqo.section_tipo
			: null

	// reset fixed_columns_map (prevents to apply rebuild_columns_map more than once)
		self.fixed_columns_map = false

	// columns
	// @see common.get_columns_map ddo_map_sequence
	// Note that default ddo_map_sequence is [show], but in search mode is [search,show]
	// datum_context allows to resolve column 'sortable' from the children contexts
	// (used by the sort_by_column property to add column sort buttons)
		self.columns_map = get_columns_map({
			context			: self.context,
			datum_context	: self.datum.context
		})

	// self.add_component_info. Indicates if exists any ddinfo (value_with_parents) in the ddo_map items list
	// When true, service_autocomplete will request ddinfo (ancestor chain) for each
	// autocomplete option so the user sees the full hierarchy path in the picker.
		// (!) This is used by service_autocomplete to decide whether to add ddinfo or not
		// sample item
		// {
		//	 "tipo": "hierarchy25",
		//	 "parent": "self",
		//	 "section_tipo": "self",
		//	 "value_with_parents": true
		// }
		const show_ddo_map				= self.request_config_object?.show?.ddo_map || []
		const ddo_value_with_parents	= show_ddo_map.find(el => el.value_with_parents)
		self.add_component_info			= ddo_value_with_parents
			? ddo_value_with_parents.value_with_parents
			: false

	// debug
		if(SHOW_DEBUG===true) {
			// console.log("/// component_portal build self.datum.data:",self.datum.data);
			// console.log("__Time to build", self.model, " ms:", performance.now()-t0);
			// console.log("component_portal self +++++++++++ :",self);
			//console.log("========= build self.pagination.total:",self.pagination.total);
		}

	// set the server data to preserve the data that is saved in DDBB
	// db_data is a deep clone used to detect whether data has changed since the last save.
		self.db_data = clone(self.data)

	// set fields_separator
	// Controls how multiple column values within a single linked record are joined
	// (e.g. "Title | Author" in the default view row).
	// Priority: context.fields_separator > request_config show.fields_separator > default ' | '
		self.context.fields_separator = self.context?.fields_separator
									|| self.request_config_object?.show.fields_separator
									|| ' | '

	// set records_separator
	// Controls how multiple linked records are joined in text/list views.
	// Priority: context.records_separator > request_config show.records_separator > default ' | '
		self.context.records_separator = self.context?.records_separator
									|| self.request_config_object?.show.records_separator
									|| ' | '

	// show_interface. Composed ONCE, here, by the only writer (see compose_show_interface)
		compose_show_interface(self)


	// status update
		self.status = 'built'


	return true
}//end component_portal.prototype.build



/**
* VIEW_TOOLBAR_FORBIDDEN_KEYS
* show_interface keys a render_views entry may NOT declare.
*
* `show_autocomplete` is an INPUT PATH, not a toolbar button: a view adds ways to put
* data into the component and removes none. The tree (picker) view is exactly the case —
* a portal whose properties.source.mode is 'autocomplete' keeps its autocomplete input
* while gaining the term picker. `read_only` and `permissions` are refused for the same
* reason from the other side: a view must never widen or narrow what the server granted.
*
* This is the mechanical form of the rule; the comment on the tree entry only explains it.
*/
const VIEW_TOOLBAR_FORBIDDEN_KEYS = Object.freeze([
	'show_autocomplete',
	'read_only',
	'permissions'
])



/**
* COMPOSE_SHOW_INTERFACE
* THE single writer of `self.show_interface` for a portal, called once per build.
*
* Composition order, and why:
*  1. `set_context_vars` (component_common → common) has already produced the base:
*     the ontology's `properties.show_interface` (or `request_config.show.interface`),
*     with every missing key filled from the client defaults.
*  2. Multi-target constraints: a portal with more than one target section cannot offer
*     "add new record" or "open section list" — the server would not know which target
*     section the action refers to.
*  3. The VIEW's declared toolbar, read as data from the matching `render_views` entry.
*     It used to be written by the view module during render() — i.e. AFTER this
*     composition — so which of the two won was last-writer-wins by accident.
*  4. The source.mode / tool-caller constraints, applied LAST and deliberately so: an
*     external portal is server-computed (nothing may be linked into it) and a portal
*     embedded in a tool is driven by the tool, so neither may be re-opened by a view
*     declaration. Under the old accidental ordering the view won these two cases.
*
* Keys the view may not declare are refused loudly and ignored (see
* VIEW_TOOLBAR_FORBIDDEN_KEYS): a declaration that removes an input path is a defect in
* the declaration, not a preference to honour silently.
*
* @param {Object} self - The `component_portal` instance (module-private function,
*                        not a method).
* @returns {Object} The composed `self.show_interface`.
*/
const compose_show_interface = function(self) {

	const show_interface = self.show_interface || {}

	// multi-target constraints
	// Multi-target portals cannot offer the "add new record" button because the server
	// would not know which target section to create the new record in.
		const multiple_target = Array.isArray(self.target_section) && self.target_section.length > 1
		show_interface.button_add = multiple_target
			? false
			: show_interface.button_add ?? true

	// check if the target section is multiple to remove the open_section_list
		show_interface.button_list = multiple_target
			? false
			: show_interface.button_list ?? true

	// view declared toolbar. Data on the render_views entry, never written by the view module
	// (!) The view is resolved exactly as the render dispatcher resolves it
	// (render_edit_component_portal.prototype.edit), so the entry composed here is always
	// the entry that will render.
		const view = self.view || self.context?.view || null
		const view_entry = (self.render_views || []).find(item =>
			item.view===view && item.mode===self.mode
		)
		const declared = view_entry?.show_interface
		if (declared) {
			for (const [key, value] of Object.entries(declared)) {
				if (VIEW_TOOLBAR_FORBIDDEN_KEYS.includes(key)) {
					console.error(
						`(!) [compose_show_interface] refused: the render_views entry {view:'${view}',`
						+ ` mode:'${self.mode}'} declares "${key}", which is an input path, not a toolbar`
						+ ' button. A view ADDS input paths and removes none. Declaration ignored.'
					);
					continue;
				}
				show_interface[key] = value
			}
		}

	// source.mode / caller constraints. Applied last: they describe what the component IS,
	// which no view declaration may re-open.
		switch (true) {

			// External mode: portal data is computed server-side (inverse / dependent relations).
			// The user can view but not add/link/edit — only the external button and list are shown.
			case (self.context.properties?.source?.mode==='external'):
				show_interface.button_add			= false
				show_interface.button_link			= false
				show_interface.tools				= false
				show_interface.button_external		= true
				show_interface.button_tree			= false
				show_interface.button_list			= show_interface.button_list ?? true
				show_interface.show_autocomplete	= show_interface.show_autocomplete ?? false
				break;

			// Tool caller: the portal is embedded inside a tool (e.g. tool_indexation).
			// Strip all action buttons; the tool controls the interaction itself.
			case (self.caller && self.caller.type==='tool'):
				show_interface.button_add		= false
				show_interface.button_link		= false
				show_interface.tools			= false
				show_interface.button_external	= false
				show_interface.button_tree		= false
				show_interface.button_list		= false
				break;

			default:
				break;
		}

	self.show_interface = show_interface


	return show_interface
}//end compose_show_interface



/**
* LINK_RECORD
* Inserts ONE new locator into the portal, persisting the change via the API.
*
* The length-1 case of `link_records` — same door, same duplicate detection, same
* refresh — kept as the stable single-pick entry point:
*  - `service_autocomplete` when the user picks an option from the datalist.
*  - `initiator_link_<id>` event handler (picker modal confirm).
*  - `component_relation_*` client models, which inherit this method verbatim.
*
* @param {Object} value                      - Locator to insert.  Will be mutated:
*                                             `from_component_tipo` is always added.
* @param {string} value.section_tipo         - Target section tipo.
* @param {string|number} value.section_id    - Target record id.
* @param {string} [value.type]               - Relation type. Absent for a term pick: the
*                                              server resolves it from the model.
* @param {string} [value.tag_id]             - Inline tag id (indexation portals).
* @param {string} [value.tag_component_tipo] - Component tipo carrying the tag (indexation).
* @returns {Promise<boolean>} `false` if the locator already exists or the API fails;
*                             `true` after a successful insert and refresh.
*/
component_portal.prototype.link_record = async function(value) {

	const self = this

	const outcome = await self.link_records([value])


	return outcome.linked.length===1
}//end link_record



/**
* LINK_RECORDS
* THE insert door of the portal: links a SELECTION of locators in ONE save.
*
* One save, not N — a term picker confirms a whole selection, and the properties that
* decide whether a locator may land (dedup, the selection cap resolved from
* `properties.data_limit`, the target set) are batch-scoped: N individually-legal picks
* sent as N requests can collectively break the cap. The server evaluates the array
* inside one transaction; this door sends it as one.
*
* Duplicate detection is performed at two levels:
*  1. Client-side fast path (level 1): scans `current_entries` (the currently loaded
*     paginated page only) AND the locators already accepted in this same batch, so two
*     identical picks in one selection collapse exactly as two successive saves would.
*  2. Server-side authoritative check (level 2): after `change_value`, compares the new
*     `total` against `total_before`. The delta is how many locators actually landed.
*
* For `component_dataframe` models, the pairing keys (`type`, `id_key` — the main
* data item id — and `main_component_tipo`) are copied from `self.data` into each
* locator before the API call so the server can attach the correct dataframe stub.
*
* (!) `self.data.pagination.limit` is explicitly set before calling `change_value` so
* the server uses the paginator's current page size when refreshing the portal data.
* This is critical for `component_relation_index` portals (e.g. 'rsc860' in Oral History)
* which have small page limits and would otherwise receive the wrong page slice.
*
* NOTHING IS DROPPED SILENTLY: every locator that does not land comes back in `refused`
* with a named reason. The one case this door cannot name is a server refusal of PART of
* the batch — the save API answers with a `total`, not yet with the per-locator
* `{outcomes:[{locator,status,code,reason}]}` the relations write door produces. When the
* count identifies the missing locators unambiguously they are named; otherwise the
* refusal is reported as an unidentified one rather than blamed on a locator.
*
* @param {Array<Object>} values - Locators to insert, length >= 1. Each is mutated:
*                                 `from_component_tipo` is always added.
* @param {Object} [options]
* @param {boolean} [options.enforce_client_data_limit=true] - When false the client-side
*        `data_limit` alert is skipped. The term picker passes false: its selection was
*        already bounded by the server-resolved remaining capacity, and the write path
*        re-resolves the cap inside its transaction — a client alert there would be a
*        second, weaker authority over the same rule.
* @param {Array<Object>} [options.replace_entries=[]] - Stored locators this save must
*        REMOVE, addressed by their per-item `id`. They are emitted as 'remove' entries
*        AHEAD of the inserts in the same `changed_data`, which is what makes a
*        single-valued (`data_limit:1`) replace one transaction instead of a delete
*        followed by a fallible insert. An entry without a usable id is refused
*        (`replace_entry_without_id`) and nothing is written: a remove with a null id
*        clears the whole component in every language.
* @returns {Promise<Object>} `{linked:[locator], refused:[{locator, reason}], total}`.
*        `reason` is one of `cancelled` (the owner row lock was refused: the user kept a
*        pending edit in the rows), `data_limit`, `duplicate`, `api_error`, `not_stored`,
*        `refused_by_server`, `replace_entry_without_id`, or `replace_failed — …` (the
*        replace removed the stored value and the server refused the new one; the note
*        says whether the previous value could be restored).
*/
component_portal.prototype.link_records = async function(values, options={}) {

	const self = this

	// owner row lock (common.js lock_rows), BEFORE the first mutation: a pending
	// editor value in this portal's rows refuses the operation here, with nothing
	// sent or changed (WC-2026-10-30-section-record-row-box)
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return {linked: [], refused: (Array.isArray(values) ? values : []).map(value => ({locator: value, reason: 'cancelled'})), total: self.total ?? null}
		}
		try {
			return await link_records_locked(self, values, options)
		} finally {
			release_rows()
		}
}//end link_records



/**
* LINK_RECORDS_LOCKED
* The body of `link_records`, run under the owner row lock.
* `self.link_records` (the restore re-entry) passes the held lock through.
* @param {Object} self - The `component_portal` instance
*/
const link_records_locked = async function(self, values, options={}) {

	// refused. Every locator that does not land is named here
		const refused = []

	// values. Always an array; a single locator is the length-1 case
		if (!Array.isArray(values) || values.length<1) {
			console.error('(!) [component_portal.link_records] refused: values must be a non-empty array. Received:', values);
			return {linked: [], refused: refused, total: self.total ?? null}
		}

	// options
		const enforce_client_data_limit = options.enforce_client_data_limit!==false

	// replace_entries. Stored locators this save must REMOVE before it inserts — the
	// single-valued (`data_limit:1`) picker replace. A replace is ONE operation and is
	// therefore ONE save: when it was two (delete_locator, then link_records) the
	// destructive half ran first and its answer was never read, so a refused pick left
	// the curated relation deleted, the field empty and the operator told only that the
	// pick had failed.
		const replace_entries = Array.isArray(options.replace_entries)
			? options.replace_entries
			: []

	// remove_changes. One 'remove' per stored locator, addressed by its per-item
	// counter id.
	// (!) NEVER SEND A REMOVE WITHOUT AN id. save_component.ts reads `change.id ?? null`,
	// and a null id there does not mean "remove nothing" — it means "clear ALL entries in
	// all languages" (its own comment: "PHP: id null = clear ALL entries in all
	// languages"), and it answers ok. An entry whose id we do not know would therefore
	// wipe the whole component instead of superseding one value. `0` is refused with it:
	// it is the client's own unknown-id sentinel and collapses to null on the wire. A
	// missing id is a bug in the caller's data, refused loudly here before anything is
	// written rather than guessed at.
		const remove_changes = []
		for (let i = 0; i < replace_entries.length; i++) {
			const entry		= replace_entries[i]
			const entry_id	= entry ? entry.id : null
			if (!Number.isFinite(Number(entry_id)) || Number(entry_id)<=0) {
				console.error(
					'(!) [component_portal.link_records] refused: replace_entries carries an entry'
					+ ' without a usable id, and a remove without an id clears the whole component.'
					+ ' component:', self.tipo, entry
				);
				for (let j = 0; j < values.length; j++) {
					refused.push({locator: values[j], reason: 'replace_entry_without_id'})
				}
				return {linked: [], refused: refused, total: self.total ?? null}
			}
			remove_changes.push(Object.freeze({
				action	: 'remove',
				id		: entry_id,
				value	: null
			}))
		}

	// current_value. Get the current_value of the component
		const current_entries = self.data.entries || []

	// data_limit. Maximum records allowed by this portal.
	// (!) Soft client cap for the add paths that have no server-resolved capacity in
	// hand (autocomplete, picker modal, add_new_element). The term picker opts out.
		if (enforce_client_data_limit && data_limit_reached(self)) {
			// alert (raised inside data_limit_reached) and stop the process
			for (let i = 0; i < values.length; i++) {
				refused.push({locator: values[i], reason: 'data_limit'})
			}
			return {linked: [], refused: refused, total: self.total ?? null}
		}

	// accepted. Locators that pass the client-side checks
		const accepted = []
		const values_length = values.length
		for (let i = 0; i < values_length; i++) {

			const value = values[i]

			// exists. Check if value already exists.
			// (!) Only the currently loaded paginated page is available for this check; the
			// server performs the authoritative full-dataset check after the insert (level 2 below).
			// (!) tag_id is part of the identity, as in the server dedup key (relations/save.ts
			// normalizeRelationInsert): the same record linked by two text tags (tags_reference,
			// tags_draw) is two values. Without it the second tag was refused as 'duplicate'.
			// Locators without tag_id (plain portals) compare undefined===undefined, as before.
			// String() keeps the id-type coercion the loose compare had (a tag_id is a number
			// in the client and a string once stored).
				const same_value = (item) => item.section_tipo===value.section_tipo
					&& String(item.section_id) === String(value.section_id)
					&& String(item.tag_id) === String(value.tag_id)
				const exists = current_entries.find(same_value) || accepted.find(same_value)
				if (typeof exists!=='undefined') {
					console.log('[link_records] Value already exists (1) !');
					if(SHOW_DEBUG===true) {
						console.log('link_records current_entries:', current_entries);
						console.log('link_records value:', value);
					}
					refused.push({locator: value, reason: 'duplicate'})
					continue;
				}

			// adds its own tipo as 'from_component_tipo' to the new locator
			// This property is used by the section's relations bag to partition locators
			// per component.  Without it the server cannot assign the locator to this portal.
				value.from_component_tipo = self.tipo

			// dataframe case
			// Unified contract: the persisted frame carries only the unified pairing key
			// id_key (the MAIN DATA ITEM id) plus the type marker and main_component_tipo.
			// id_key is sourced exclusively from self.data.id_key (the item id threaded by
			// section_record.js); it is NEVER derived from a section_id / section_id_key.
			// The type marker is the CONSTANT, not whatever the view left on the locator:
			// a picker-sourced locator carries no type at all (the server resolves it from
			// the model), and the server forces dd490 for a frame regardless. This keeps
			// the payload honest at the source.
				if(self.model === 'component_dataframe'){
					value.type					= DATAFRAME_TYPE
					value.id_key				= self.data.id_key
					value.main_component_tipo	= self.data.main_component_tipo
				}

			accepted.push(value)
		}
		if (accepted.length===0) {
			return {linked: [], refused: refused, total: self.total ?? null}
		}

	// changed_data
	// The removes this save must carry FIRST, then one 'insert' entry per accepted
	// locator — ONE save, ONE transaction, so a replace has no window in which the
	// component holds nothing.
	// (!) THE REMOVES MUST PRECEDE THE INSERTS, and that is not a style choice.
	// save_component.ts applies changed_data entries in order over one mutating items
	// array, and the selection cap (relations/save.ts refuseByPickerConstraint gate 4)
	// judges the count the set would RESULT in: with the insert first a data_limit:1
	// caller reaches 2 and the pick is refused outright. Removes first leaves the
	// resulting count at 1, which the cap accepts.
	// Frozen to prevent accidental mutation after this point.
		const changed_data = remove_changes.concat(accepted.map(value => Object.freeze({
			action	: 'insert',
			id		: null,
			value	: value
		})))

	// debug
		if(SHOW_DEBUG===true) {
			console.log("[component_portal.link_records] accepted:", accepted, " - changed_data:", changed_data);
		}

	// total_before
	// Snapshot the current total before the insert so we can detect duplicates at level 2.
		const total_before = clone(self.total)

	// (!) fix pagination limit in data to force server to use it. Important
	// This value is get from API save $data->pagination and set to the component->pagination->limit
	// This is used frequently in component_relation_index like 'rsc860' in Oral History indexation terms
		self.data.pagination = {
			limit : self.paginator
				? self.paginator.limit
				: null
		}

	// api_response : change_value (and save)
	// refresh:false — we handle the refresh manually below after the total check.
		const api_response = await self.change_value({
			changed_data	: changed_data,
			refresh			: false // not refresh here (!)
		})

		const saved_datum = response_data(api_response)
		if (!api_response || !saved_datum) {
			console.error('Invalid API response on link_records:', api_response);
			for (let i = 0; i < accepted.length; i++) {
				refused.push({locator: accepted[i], reason: 'api_error'})
			}
			return {linked: [], refused: refused, total: self.total ?? null}
		}

	// total check (after save) — server-authoritative duplicate detection (level 2)
		const current_data	= saved_datum.data.find(el => el.tipo===self.tipo)
		const total			= current_data?.pagination?.total ?? 0
		// landed. How many of the accepted locators the server actually stored.
		// (!) THE BASELINE IS POST-REMOVE. `total_before` is what the component held when
		// this call started, and the removes carried by THIS SAME SAVE are already gone
		// from it, so the delta has to be measured against `total_before - removes`.
		// Without the subtraction a data_limit:1 replace (one removed, one inserted, total
		// still 1) computed landed = 0 and reported a SUCCESSFUL replace as a 'duplicate',
		// returning before the refresh below: the operator got an error alert and a stale
		// value for a change that had in fact been stored. A correct operation reported as
		// a failure is how people learn to ignore the warnings that matter.
		// (!) A NaN total_before (an instance built without a server total) is not a
		// refusal: it carries no information, so the server's own count is taken as is.
		const total_before_int	= parseInt(total_before)
		const landed			= Number.isNaN(total_before_int)
			? accepted.length
			: (parseInt(total) - (total_before_int - remove_changes.length))

		// THE REPLACE DESTROYED AND DID NOT CREATE — the one case this door cannot
		// prevent, only name and try to undo.
		// The removes and the insert travelled in ONE save, but save_component.ts applies
		// changed_data entries in order over one mutating items array and DROPS a refused
		// relation insert (`if (validated === null) continue;`) instead of failing the
		// save — so the removes stand and nothing replaced them, and the component is now
		// EMPTY. Never report this as a duplicate: what happened is that a curated
		// relation was deleted and the pick meant to replace it was refused.
		if (remove_changes.length>0 && landed<=0) {

			// refresh FIRST. `self.data` still holds the pre-save entries, and the restore
			// below re-enters this same door, whose level-1 duplicate check reads
			// `self.data.entries` — against a stale one the restore would be refused as a
			// duplicate of the value that is no longer there. The save response already
			// carries the post-save data, so this costs no extra request.
			await self.refresh({
				build_autoload		: true,
				tmp_api_response	: api_response
			})

			// BEST-EFFORT COMPENSATION, not a rollback. The previous locators are re-linked
			// in a second save; `id` and `paginated_key` are stripped so the server mints
			// fresh item ids instead of writing back a counter value it no longer owns.
			// It can itself be refused — a stored locator is exempt from the picker
			// constraints only while it IS stored, so an old target that has since become
			// unreadable or non-selectable will not come back — and a dataframe frame that
			// the remove cascaded away (save_component.ts removeDataframeDataById) never
			// does. The outcome is therefore reported, never assumed.
			// (!) No recursion risk: this call passes no `replace_entries`, so
			// `remove_changes` is empty there and this branch cannot be re-entered.
			const restore_locators = replace_entries.map(entry => {
				const copy = Object.assign({}, entry)
				delete copy.id
				delete copy.paginated_key
				return copy
			})
			const restored = await self.link_records(restore_locators, {
				enforce_client_data_limit : false
			})
			const restore_note = restored.linked.length===restore_locators.length
				? 'the previous value was restored'
				: 'THE PREVIOUS VALUE COULD NOT BE RESTORED — re-link it by hand'
			console.error(
				'(!) [component_portal.link_records] the replace removed the stored value and the'
				+ ` server refused the new one. component: ${self.tipo} — ${restore_note}`,
				{removed: replace_entries, refused_insert: accepted, restore: restored}
			);
			for (let i = 0; i < accepted.length; i++) {
				refused.push({locator: accepted[i], reason: `replace_failed — ${restore_note}`})
			}
			return {linked: [], refused: refused, total: restored.total ?? total}
		}

		// error on add value case
		if (total===0) {
			console.warn("// link_records saved data (unexpected total):", saved_datum.data);
			for (let i = 0; i < accepted.length; i++) {
				refused.push({locator: accepted[i], reason: 'not_stored'})
			}
			return {linked: [], refused: refused, total: 0}
		}
		// value already exists case. Check if value already exist.
		// (!) Note that here, the whole portal data has been compared in server
		if (landed<=0) {
			// self.update_pagination_values('remove') // remove added pagination value
			console.log("[link_records] Value already exists (2) !");
			for (let i = 0; i < accepted.length; i++) {
				refused.push({locator: accepted[i], reason: 'duplicate'})
			}
			return {linked: [], refused: refused, total: total}
		}

	// refresh self component
	// Pass tmp_api_response so build() reuses the save response instead of
	// issuing a second API call for the same data.
		await self.refresh({
			build_autoload		: true,
			tmp_api_response	: api_response // pass api_response before build to avoid call API again
		})

	// picker. THE PANE STAYS OPEN ACROSS THE PICK. The refresh above rebuilt this
	// component's own DOM; the pane is a body-level sibling and its area is not in
	// ar_instances, so both survive — what the tree still needs is the stored
	// truth about what is now linked (an optimistic pick may have been refused
	// or deduped server-side), so the picked term repaints as linked and the
	// remaining capacity moves. Picking several terms is several clicks, with
	// the panel open the whole time.
		if (self.picker && typeof self.picker.sync_linked==='function') {
			self.picker.sync_linked()
		}

	// partial refusal. The server stored fewer locators than were sent
		let linked = accepted
		if (landed<accepted.length) {
			// missing. The accepted locators that are absent from the refreshed data.
			// It is trusted ONLY when it agrees with the server's own count; otherwise
			// the refreshed page is a partial view (pagination) and naming a locator
			// from it would be a guess. Per-locator reasons arrive when the save API
			// answers with the relations door's `{outcomes:[…]}` instead of a total.
			const refreshed_entries	= self.data.entries || []
			const missing			= accepted.filter(value =>
				!refreshed_entries.find(item => item.section_tipo===value.section_tipo && String(item.section_id) === String(value.section_id))
			)
			const unnamed = accepted.length - landed
			if (missing.length===unnamed) {
				for (let i = 0; i < missing.length; i++) {
					refused.push({locator: missing[i], reason: 'refused_by_server'})
				}
				linked = accepted.filter(value => !missing.includes(value))
			}else{
				console.error(
					`(!) [component_portal.link_records] the server refused ${unnamed} of ${accepted.length}`
					+ ' locators and the response does not say which. component:', self.tipo, accepted
				);
				refused.push({locator: null, reason: `refused_by_server (${unnamed} unidentified)`})
			}
		}

	// filter data. check if the caller has tag_id
	// If the portal is in indexation mode with an active tag, re-apply the tag
	// filter so the newly-inserted locators appear in the correct tag subset.
		if(self.active_tag){
			self.node.classList.add('hide')
			// filter component data by tag_id and re-render content
			self.filter_data_by_tag_id(self.active_tag)
			.then(()=>{
				self.node.classList.remove('hide')
			})
		}

	// mode specifics
		switch(self.mode) {

			case 'search' :
				// publish change. Event to update the DOM elements of the instance
				event_manager.publish('change_search_element', self)
				self.node.classList.remove('active')
				break;

			default:

				break;
		}


	return {linked: linked, refused: refused, total: total}
}//end link_records_locked



/**
* ADD_NEW_ELEMENT
* Creates a new blank record in the target section and immediately links it to this portal.
*
* Called by the "add" button rendered by the portal's edit view.  Combines two operations
* in a single API call: section record creation + portal locator insertion.  The server
* assigns the new record a section_id, writes the locator into the portal data, and
* returns the updated portal datum so the client can refresh without a second request.
*
* The server also assigns the new record to the correct project based on the current
* user's privileges and the section's project configuration.
*
* Unlike `link_record` (which links an *existing* record), this function always creates
* a *new* record.  The duplicate-detection step in `link_record` does not apply here.
*
* (!) Respects the `data_limit` property: if the portal is already at capacity the
* action is blocked before the API call.
*
* (!) Side effect: `self.created_section_id` is set to the section_id the server
* created (response_data(api_response).created_section_id), or null when the server did
* not report one.  The add button opens THAT record — the return value stays a
* boolean because the client test suite pins it.
*
* @verified 07-09-2023 Paco
* @param {string} target_section_tipo - Ontology tipo of the section in which the new
*                                       record should be created (e.g. 'rsc197').
* @returns {Promise<boolean>} `true` after a successful create+link and refresh;
*                             `false` if the data limit is reached or the API fails.
*/
component_portal.prototype.add_new_element = async function(target_section_tipo) {

	const self = this

	// owner row lock (common.js lock_rows), BEFORE the first mutation: a pending
	// editor value in this portal's rows refuses the operation here, with nothing
	// sent or changed (WC-2026-10-30-section-record-row-box)
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await add_new_element_locked(self, target_section_tipo)
		} finally {
			release_rows()
		}
}//end add_new_element



/**
* ADD_NEW_ELEMENT_LOCKED
* The body of `add_new_element`, run under the owner row lock.
* @param {Object} self - The `component_portal` instance
*/
const add_new_element_locked = async function(self, target_section_tipo) {

	// created_section_id. Reset before the call so a failed add never leaves the
	// previous creation's address behind for the button to open.
		self.created_section_id = null

	// data_limit. Maximum records allowed by this portal
		if (data_limit_reached(self)) {
			// alert and stop the process
			return false
		}

	// source
		const source = create_source(self, null)

	// data
	// Clone self.data to avoid mutating the live data before the server confirms.
		const data = clone(self.data)
		data.changed_data = [{
			action	: 'add_new_element',
			id		: null,
			value	: target_section_tipo
		}]

	// rqo
		const rqo = {
			action	: 'save',
			source	: source,
			data	: data
		}

	// data_manager. create new record
	// Short timeout (10 s) and a single retry: record creation must not be retried
	// silently because a retry could create a duplicate record.
		const api_response = await data_manager.request({
			body : rqo,
			retries : 1, // one try only
			timeout : 10 * 1000 // 10 secs waiting response
		})
		// add value to current data
		const created_datum = response_data(api_response)
		if (created_datum) {

			// created_section_id. The ADDRESS of the record the server just created.
			// Read it before the refresh: the caller (buttons.render_button_add) opens
			// this record instead of guessing it from the echoed page, which is only
			// the new one when the whole list fits on that page.
				self.created_section_id = created_datum.created_section_id ?? null

			// save return the datum of the component
			// Inject the save response as tmp_api_response so the build phase uses it
			// directly rather than issuing a redundant API read.
				await self.refresh({
					destroy				: false,
					build_autoload		: true,
					tmp_api_response	: api_response
				})

		}else{
			console.error('Error on api_response on try to create new row:', api_response);
			return false
		}


	return true
}//end add_new_element_locked



/**
* DATA_LIMIT_REACHED
* Module-private guard that checks whether the portal has reached the maximum
* number of linked records allowed by `context.properties.data_limit`.
*
* Called by `link_records` (unless the caller opts out) and by `add_new_element` before
* any API call. If the limit is exceeded, it alerts the user (using the localised
* `exceeded_limit` label when available) and returns `true` so the caller can bail out.
*
* The check compares `self.data.entries.length` against `data_limit`, so it only
* counts entries on the **currently loaded page**.  This is a soft client-side cap for
* the add paths that have no server-resolved capacity in hand.
*
* (!) IT IS NOT THE TERM PICKER'S AUTHORITY, and must not become one. The picker is
* opened with the server-resolved constraint `{selection_limit, remaining, targets}`
* (`context.picker`), bounds its selection tray at `remaining` BEFORE the user commits,
* and the relations write door re-resolves the same cap inside its transaction. A second
* client-side cap over the same rule can only disagree with those two — so the picker
* path calls `link_records(..., {enforce_client_data_limit:false})` and this guard is
* left to the paths that genuinely have no other answer (autocomplete, picker modal,
* add_new_element). It also reads `data_limit` raw, not the remaining capacity, which is
* the wrong arithmetic for a multi-pick selection.
*
* @param {Object} self - The component_portal instance (not `this`; called as a
*                        module-level function, not a method).
* @returns {boolean} `true` if the portal is at or above its limit and the action
*                    should be blocked; `false` if the insert may proceed.
*/
const data_limit_reached = function (self) {

	// current_value. Get the current_value of the component
		const current_value	= self.data.entries || []

	// data_limit. Maximum records allowed by this portal
	// Check if the component has a data_limit (it could be defined in properties as data_limit with int value)
		const data_limit = self.context.properties.data_limit
		if(data_limit && current_value.length>=data_limit){

			console.log("[data_limit_reached] Data limit is reached!");

			// notify to user about the limit
			const data_limit_label = (
				get_label.exceeded_limit || 'The maximum number of values for this field has been reached. Limit ='
			) + ' ' + data_limit
			window.alert(data_limit_label)

			return true
		}


	return false
}//end data_limit_reached



/**
* UPDATE_PAGINATION_VALUES
* Synchronises `self.total`, `self.rqo.sqo.offset/total`, `self.data.pagination`, and
* the paginator child instance after a local data change (insert or remove).
*
* This method is used when the portal wants to adjust pagination state *without*
* making a new API call — specifically to keep the paginator showing the correct
* page after an insert or remove operation that has already been confirmed by the
* server.
*
* The `last_offset` IIFE calculates the offset of the *last page* so that after an
* insert the paginator navigates to the page where the new entry appears (the end),
* and after a remove it navigates to the last valid page.
*
* A one-shot `render_<id>` subscription triggers `self.paginator.refresh()` after the
* next render cycle to avoid updating the paginator DOM before the portal content is
* ready (which would cause visual artifacts).
*
* Note: the commented-out `self.data.pagination.total++/--` lines are intentionally
* preserved — the live adjustment is done via `self.total` only; `self.data.pagination`
* is synced afterwards.
*
* @param {string} action - 'add' increments `self.total`; 'remove' decrements it.
*                          Any other value leaves the total unchanged.
* @returns {boolean} Always `true`.
*/
component_portal.prototype.update_pagination_values = function(action) {

	const self = this

	// update self.data.pagination
		switch(action) {
			case 'remove' :
				// update pagination total
				if(self.data.pagination && self.data.pagination.total && self.data.pagination.total>0) {
					// self.data.pagination.total--
					self.total--
				}
				break;
			case 'add' :
				// update self.data.pagination
				if(self.data.pagination && self.data.pagination.total && self.data.pagination.total>=0) {
					// self.data.pagination.total++
					self.total++
				}
				break;
			default:
				// Nothing to add or remove
		}
		// self.total = self.data.pagination.total


	// last_offset
	// Compute the offset of the last page so the paginator navigates there.
	// Returns 0 when total or limit is 0 (no pagination needed).
		const last_offset = (()=>{

			const total	= self.total
			const limit	= self.rqo.sqo.limit

			if (total>0 && limit>0) {

				const total_pages = Math.ceil(total / limit)

				return parseInt( limit * (total_pages -1) )
			}

			return 0
		})()

	// self pagination update
		self.rqo.sqo.offset	= last_offset

		if (!self.data.pagination) {
			self.data.pagination = {}
		}
		self.data.pagination.offset	= last_offset
		self.data.pagination.total	= self.total// sync pagination info
	// paginator object update
		self.paginator.offset	= self.rqo.sqo.offset
		self.paginator.total	= self.total

	// paginator content data update (after self update to avoid artifacts (!))
	// Subscribe to the next render_<id> event to defer the paginator DOM refresh
	// until the portal content has finished rendering.
		let token
		const render_handler = () => {
			// remove the event to prevent multiple equal events
			event_manager.unsubscribe(token)
			// refresh paginator if already exists
			if (self.paginator) {
				self.paginator.refresh()
			}
		}
		token = event_manager.subscribe('render_'+self.id, render_handler)
		self.events_tokens.push(token)


	return true
}//end update_pagination_values



/**
* FILTER_DATA_BY_TAG_ID
* Filters the portal's displayed entries to only those whose `tag_id` matches the
* given tag, then re-renders the portal content without a server round-trip.
*
* Used in the `indexation` view: when the user clicks on an inline text tag in the
* text editor, the portal should show only the thesaurus terms that are indexed against
* that specific tag.  Clicking a different tag calls this function again; clicking away
* calls `reset_filter_data`.
*
* The function always re-reads `full_data` from `self.datum` (the unfiltered server-
* authoritative data) so that switching between tags does not progressively narrow the
* dataset — without this, the second tag click would filter the already-filtered subset.
* A deep clone of `full_data` is assigned to `self.data` to protect `self.datum` from
* mutation.
*
* Also called after `link_record` / `unlink_record` when `self.active_tag` is set, so
* the post-save display reflects the current tag filter.
*
* Fired by:
*  - Direct call from `link_record` / `unlink_record` when `self.active_tag` is set.
*  - Event handler defined in ontology properties (e.g. `rsc860` in Oral History).
*
* @param {Object} options               - Active-tag descriptor (stored in `self.active_tag`).
* @param {Object} options.tag           - Tag metadata object from the text editor.
* @param {string} options.tag.node_name - DOM node name of the tag element (e.g. 'img').
* @param {string} options.tag.type      - Tag type string (e.g. 'indexOut').
* @param {string} options.tag.tag_id    - The tag's unique id; used as the filter key.
* @param {string} options.tag.state     - Tag state (e.g. 'd' for default).
* @param {string} options.tag.label     - Display label of the tag.
* @param {string} options.tag.data      - Additional tag data payload.
* The owner row lock (common.js lock_rows) is acquired BEFORE `self.data` is
* replaced: a pending editor value in the current rows refuses the filter (false)
* with nothing changed (WC-2026-10-30-section-record-row-box).
*
* @returns {Promise<HTMLElement|null|false>} The result of
*   `self.render({render_level:'content'})`, or false when the row lock was refused.
*/
component_portal.prototype.filter_data_by_tag_id = async function(options) {

	const self = this

	// owner row lock, before the first mutation
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}

	try {

	// options
		const tag = options.tag // object

	// Fix received options from event as 'active_tag'
	// Store the full options object as self.active_tag so subsequent operations
	// (link_record, unlink_record, reset_filter_data) know the current filter state.
		self.active_tag = options

	// short vars
		const tag_id = tag?.tag_id

	// get all data from datum because if the user select one tag the portal data is filtered by the tag_id,
	// in the next tag selection by user the data doesn't have all locators and is necessary get the original data
	// the full_data is clone to a new object because need to preserve the datum from these changes.
		// (per occurrence: owner decision (b), select_by_caller_chain)
		const full_data	= select_by_caller_chain(
			self.datum.data.filter(el =>
				el.tipo===self.tipo &&
				el.section_tipo===self.section_tipo &&
				String(el.section_id) === String(self.section_id)
			),
			() => get_caller_chain_tipos(self)
		) || {}
		self.data = clone(full_data)

	// the portal will use the filtered data value to render it with the tag_id locators.
		self.data.entries = self.data.entries
			? self.data.entries.filter(el => el.tag_id === tag_id)
			: []

	// reset status to enable re-render
		self.status = 'built'

	// re-render always the content
		return await self.render({
			render_level : 'content'
		})

	} finally {
		release_rows()
	}
}//end filter_data_by_tag_id



/**
* RESET_FILTER_DATA
* Clears the active tag filter and restores `self.data` to the full, unfiltered
* server-authoritative dataset from `self.datum`.
*
* Counterpart of `filter_data_by_tag_id`: called when the user deselects a tag or
* navigates away from the tag-filtered view so the full list of linked records is shown again.
*
* Directly assigns from `self.datum.data` (no clone needed here because there is no
* partial mutation of the datum — self.data simply points at the matching entry).
*
* The owner row lock (common.js lock_rows) is acquired BEFORE `self.data` is
* replaced: a pending editor value in the current rows refuses the reset (false)
* with nothing changed (WC-2026-10-30-section-record-row-box).
*
* @returns {Promise<HTMLElement|null|false>} The result of
*   `self.render({render_level:'content'})`, or false when the row lock was refused.
*/
component_portal.prototype.reset_filter_data = async function() {

	const self = this

	// owner row lock, before the first mutation
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}

	try {

	// reset self.active_tag (important)
	// Clearing self.active_tag tells link_record / unlink_record not to re-apply
	// the filter after the next save.
		self.active_tag = null

	// refresh the data with the full data from datum and render portal.
		// (per occurrence: owner decision (b), select_by_caller_chain)
		self.data = select_by_caller_chain(
			self.datum.data.filter(el => el.tipo===self.tipo && el.section_tipo===self.section_tipo && String(el.section_id) === String(self.section_id)),
			() => get_caller_chain_tipos(self)
		) || {}

	// reset status to able re-render
		self.status = 'built'

	// reset instances status
		// self.ar_instances = null
		// for (let i = 0; i < self.ar_instances.length; i++) {
		// 	self.ar_instances[i].status = 'built'
		// }

	// re-render content
		return await self.render({
			render_level : 'content'
		})

	} finally {
		release_rows()
	}
}//end reset_filter_data



/**
* GET_SEARCH_VALUE
* Returns a stripped copy of the portal's current entries for use as an SQO filter value.
*
* In search mode the portal acts as an SQO filter input; each locator the user has added
* to the portal is sent to the server as part of the filter so the search engine can find
* records that match any of those linked records.  Only the properties required by the
* search engine are included; all other locator metadata (tag_id, type, matrix_id, …) is
* intentionally stripped to keep the filter payload small and unambiguous.
*
* @returns {Array<Object>} Array of minimal locator objects, each with:
*   `id`, `section_tipo`, `section_id`, `from_component_tipo`.
*   Returns an empty array if the portal has no entries.
*/
component_portal.prototype.get_search_value = function() {

	const self = this

	const data			= self.data || {}
	const current_value	= data.entries || []

	const new_value = [];
	const value_len = current_value.length
	for (let i = 0; i < value_len; i++) {
		new_value.push({
			id 					: current_value[i].id,
			section_tipo		: current_value[i].section_tipo,
			section_id			: current_value[i].section_id,
			from_component_tipo	: current_value[i].from_component_tipo
		})
	}

	return new_value
}//end get_search_value



/**
* NAVIGATE
* Executes a paginator-driven navigation or sort by refreshing the portal with updated
* SQO parameters (offset, limit, order).
*
* The caller supplies an async `callback` that mutates `self.rqo.sqo` (and optionally
* `self.request_config_object.sqo`) *before* the refresh is triggered.  This approach
* keeps the SQO mutation logic close to the event handler that initiated the navigation
* (see the paginator event subscriptions in `build()`).
*
* The `container` reference — `list_body` for the table view or `content_data` for the
* line view — receives the 'loading' CSS class during the fetch so the user sees a visual
* indicator.  `destroy:false` is passed to `refresh` to preserve the portal node and
* allow recovery from login-expiry scenarios without a full re-mount.
*
* Order (WC-2026-10-30-section-record-row-box): the owner row lock FIRST (it commits
* typed-not-committed editor nodes of the current rows, and refuses — returning
* false with nothing mutated — on a node it cannot commit), THEN the in-page
* `check_unsaved_data({flush_only:true})` (flush auto-saveable edits; never a prompt,
* never a page-wide reset: a page turn is an in-page operation), THEN the callback
* and the refresh. A prompting check before the lock would ask "discard?" for a
* value the lock commits cleanly.
*
* @param {Object} options              - Navigation options.
* @param {Function} [options.callback] - Async function that updates `self.rqo.sqo`
*                                        before the refresh.  Called and awaited before
*                                        fetching new data.
* @returns {Promise<boolean>} `false` if the row lock was refused or the container node
*                             is not found in the DOM; `true` after a successful refresh.
*/
component_portal.prototype.navigate = async function(options) {

	const self = this

	// owner row lock, before the first mutation (the callback)
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await navigate_locked(self, options)
		} finally {
			release_rows()
		}
}//end navigate



/**
* NAVIGATE_LOCKED
* The body of `navigate`, run under the owner row lock.
* @param {Object} self - The `component_portal` instance
* @param {Object} options - See navigate
* @returns {Promise<boolean>}
*/
const navigate_locked = async function(self, options) {

	// options
		const callback = options.callback

	// in-page flush (never prompts, never resets the page registry)
		await check_unsaved_data({
			flush_only : true
		})

	// callback execute
	// The callback mutates self.rqo.sqo (offset, limit, etc.) before the refresh
	// so the API call uses the updated parameters.
		if (callback) {
			await callback()
		}

	// container
	// Prefer list_body (table / default view) or fall back to content_data (line view).
	// If neither exists the portal DOM is not in the expected state.
		const container = self.node?.list_body // view table
					   || self.node?.content_data // view line

		if (!container) {
			console.error('Error on navigate: container not found. self.node:', self.node);
			return false
		}

	// loading
		container.classList.add('loading')

	// refresh
		await self.refresh({
			destroy : false // avoid to destroy here to allow component to recover from loosed login scenarios
		})

	// loading
		container.classList.remove('loading')


	return true
}//end navigate_locked



/**
* DELETE_LOCATOR
* Deletes one or more portal locators that match a partial locator specification.
*
* Unlike `unlink_record` (which removes by the locator's `id`) this function removes by
* **property match**: the server compares the stored locators against the `locator` object
* using only the properties listed in `ar_properties`, so it is suitable for bulk removes
* (e.g. delete all indexation locators for a given `tag_id` + `type` combination).
*
* Uses the `dd_component_portal_api` action handler (`action: 'delete_locator'`) directly
* via `data_manager.request`, bypassing the normal `change_value` path.  The caller is
* responsible for refreshing the portal after this call.
*
* Note: the `source` comments inside the body still reference 'component_text_area'; that
* is a copy-paste artefact in the original code — the actual source values are correctly
* taken from `self` (this component_portal instance).
*
* @param {Object} locator              - Partial locator used as the match template.
*                                        Only the properties named in `ar_properties`
*                                        are compared by the server.
* @param {string} [locator.tag_id]     - Tag id to match (indexation use case).
* @param {string} [locator.type]       - Relation type to match
*                                        (e.g. DD_TIPOS.DEDALO_RELATION_TYPE_INDEX_TIPO // dd96).
* @param {Array<string>} ar_properties - Names of the locator properties to use for
*                                        matching, e.g. ['tag_id', 'type'].
* @returns {Promise<Object>} Raw `data_manager.request` response from the API.
*/
component_portal.prototype.delete_locator = function(locator, ar_properties) {

	const self = this

	return data_manager.request({
		body : {
			action	: 'delete_locator',
			dd_api	: 'dd_component_portal_api', // component_portal
			source	: {
				section_tipo	: self.section_tipo, // current component_text_area section_tipo
				section_id		: self.section_id, // component_text_area section_id
				tipo			: self.tipo, // component_text_area tipo
				lang			: self.lang // component_text_area lang
			},
			options : {
				locator			: locator,
				ar_properties	: ar_properties
			}
		},
		retries : 1, // one try only
		timeout : 10 * 1000 // 10 secs waiting response
	})
}//end delete_locator



/**
* SORT_DATA
* Persists a manual drag-and-drop reorder of portal entries.
*
* Called with ABSOLUTE keys by `perform_drop` in `drag_and_drop.js` (a delegated
* row drop) and by the move-to-position modal (render_edit_component_portal.js
* `open_move_to_position`).  Sends a `sort_data` changed_data action to the server, which reorders
* the locator array in storage and returns the updated data.
*
* A drag source exists only while no TEMPORARY `view_order` is active (drag_and_drop.js
* `can_reorder`), so a manual reorder always applies to the stored order on display.
*
* Uses `refresh:false` in `change_value` then manually calls `self.refresh` with the
* API response to avoid an extra round-trip.
*
* @see perform_drop / move_to_position_decision (drag_and_drop.js)
* @verified 07-09-2023 Paco
* @param {Object} options              - Reorder parameters.
* @param {Object} options.value        - The locator object that was dragged.
* @param {string|number} options.source_key - The position key of the dragged entry
*                                             before the drop.
* @param {string|number} options.target_key - The position key of the drop target
*                                             (the entry the dragged item was dropped onto).
* @returns {Promise<Object>} Raw API response from `change_value`.
*/
component_portal.prototype.sort_data = async function(options) {

	const self = this

	// owner row lock (common.js lock_rows), BEFORE the first mutation: a pending
	// editor value in this portal's rows refuses the operation here, with nothing
	// sent or changed (WC-2026-10-30-section-record-row-box)
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await sort_data_locked(self, options)
		} finally {
			release_rows()
		}
}//end sort_data



/**
* SORT_DATA_LOCKED
* The body of `sort_data`, run under the owner row lock.
* @param {Object} self - The `component_portal` instance
*/
const sort_data_locked = async function(self, options) {

	// options
		const value			= options.value
		const source_key	= options.source_key
		const target_key	= options.target_key

	// sort_data
		const changed_data = [Object.freeze({
			action		: 'sort_data',
			source_key	: source_key,
			target_key	: target_key,
			value		: value
		})]

	// api_response : change_value (and save)
		const api_response = await self.change_value({
			changed_data	: changed_data,
			refresh			: false // not refresh here (!)
		})

	// refresh self component
		await self.refresh({
			destroy				: false,
			build_autoload		: true,
			tmp_api_response	: api_response // pass api_response before build to avoid call API again
		})


	return api_response
}//end sort_data_locked



/**
* SORT_BY_COLUMN
* PERSISTENTLY reorders the **full** portal locator array (all pages) by the resolved
* value of a target-section component, then saves the new order to the database —
* the "save current order" action of the order model (portal order model, stage O2):
* the column header click is only a TEMPORARY `view_order` (set_view_order), and this
* is what `save_view_order` sends to make it the stored order.
*
* The server sorts the set of linked `section_id`s by querying the target section's
* matrix for the named `component_tipo` value, ordered ASC/DESC with NULLS LAST, and
* writes the resulting ordered locator array back to the portal's relation data.  This
* is a real data change and is recorded by Time Machine. The server refuses it on a
* declared-order portal (reason `declared_order`: the ontology order is enforced at
* every write, so a save would change nothing).
*
* Available only on a column whose ddo declares `sort_by_column: true` (WC-048).
*
* On success the TEMPORARY `view_order` is cleared: the stored order now IS that
* order, so the view is no longer temporary (and the drag source comes back).
*
* (!) `value: null` in `changed_data` is intentional: the client's `update_data_value`
* skips null-value items with no id, so only the server performs the actual reorder.
*
* @see save_view_order (the indicator's button), set_view_order (the header click)
* @param {Object} column          - A `columns_map` entry (from `get_columns_map`).
*                                   Only `column.tipo` is used by the server.
* @param {string} direction       - Sort direction: 'ASC' or 'DESC'.
* @returns {Promise<Object|false>} Raw API response from `change_value`; false when
*   the owner row lock was refused (nothing sent).
*/
component_portal.prototype.sort_by_column = async function(column, direction) {

	const self = this

	// owner row lock (common.js lock_rows), BEFORE the first mutation: a pending
	// editor value in this portal's rows refuses the operation here, with nothing
	// sent or changed (WC-2026-10-30-section-record-row-box)
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await sort_by_column_locked(self, column, direction)
		} finally {
			release_rows()
		}
}//end sort_by_column



/**
* SORT_BY_COLUMN_LOCKED
* The body of `sort_by_column`, run under the owner row lock.
* @param {Object} self - The `component_portal` instance
* @param {Object} column - A `columns_map` entry ({tipo})
* @param {string} direction - 'ASC'|'DESC'
* @returns {Promise<Object>} Raw API response from `change_value`
*/
const sort_by_column_locked = async function(self, column, direction) {

	// sort_by_column changed_data
	// (!) value must stay null: with null value and no id, the client
	// update_data_value is a no-op and the server resolves the new order
		const changed_data = [Object.freeze({
			action			: 'sort_by_column',
			component_tipo	: column.tipo,
			direction		: direction, // 'ASC'|'DESC'
			value			: null
		})]

	// api_response : change_value (and save)
		const api_response = await self.change_value({
			changed_data	: changed_data,
			refresh			: false // not refresh here (!)
		})

	// view_order. Saved: the stored order is now this order, the view is no
	// longer temporary. A refused save keeps the temporary view as it was.
		if (api_response && !request_failed(api_response)) {
			self.view_order = null
		}

	// refresh self component. Saved: the save's echo IS the order just stored and is
	// rendered as is. Refused: the view order stands, so build() drops the echo and
	// re-reads under it (echo_hides_view_order)
		await self.refresh({
			destroy				: false,
			build_autoload		: true,
			tmp_api_response	: api_response // pass api_response before build to avoid call API again
		})


	return api_response
}//end sort_by_column_locked



/**
* SET_VIEW_ORDER
* The column header click on a portal: a TEMPORARY display order (portal order
* model, stage O2 — WC-2026-10-31-portal-order-model). Nothing is written: the
* read RQO carries `sqo.view_order = {tipo, direction}` and the server orders the
* FULL locator list by that column before paginating (`paginated_key` stays the
* STORED index, so a later persisted reorder addresses the right items).
*
* While a view order is active (drag_and_drop.js): no drag source (`can_reorder`
* / `can_drag_out` carry `!view_order`), the order indicator shows it with a clear
* action, and — never under a declared order — a "save current order" button
* (`can_save_view_order` → save_view_order → the persisted `sort_by_column`).
* Allowed on a declared-order portal too, on any `can_view_sort` column.
*
* View state, not data: it survives pagination and any later refresh (the build
* stamps it on every rebuilt rqo, sync_view_order_sqo) until clear_view_order /
* save_view_order — a link / unlink / add included: their save echo is in the stored
* order, so build() re-reads instead of rendering it (echo_hides_view_order). A new
* order starts from the first page.
*
* Same discipline as `navigate`: the owner row lock first (a pending editor value in
* the rows refuses with nothing changed), then the in-page flush, then the change and
* the content refresh. A refused or failed refresh restores the previous order; a
* failed READ (the server may refuse a column the client offers: assertViewOrder
* checks read access on every hop) also re-reads under it, so the portal stays
* usable (reread_restored_order).
*
* @param {Object|null} view_order - {tipo, direction:'ASC'|'DESC'}, or null for the
*   stored order (clear)
* @param {Object} [column] - The header's own columns_map entry (the mosaic alt table
*   has its own map); default: the `self.columns_map` entry of `view_order.tipo`
* @returns {Promise<boolean>} true when the portal re-read and re-rendered under the
*   new order; false when refused (row lock, unknown column, another read or order
*   change in flight) or failed
*/
component_portal.prototype.set_view_order = async function(view_order, column=null) {

	const self = this

	// single flight. Refused, with nothing changed, while another order change or any
	// other read is in flight (another column's arrow, Reset / Save clicked during a
	// read: the per-control guards do not see each other). Checked and claimed
	// synchronously, so two clicks can never both pass it
		if (!view_order_idle(self)) {
			return false
		}
		self.view_order_changing = true
		try {
			return await set_view_order_claimed(self, view_order, column)
		} finally {
			self.view_order_changing = false
		}
}//end set_view_order



/**
* SET_VIEW_ORDER_CLAIMED
* The body of `set_view_order`, run with the single-flight claim held
* (`view_order_changing`).
* @param {Object} self - The `component_portal` instance
* @param {Object|null} view_order - {tipo, direction}, or null (clear)
* @param {Object|null} column - The header's own columns_map entry
* @returns {Promise<boolean>}
*/
const set_view_order_claimed = async function(self, view_order, column) {

	// normalize. null = the stored order
		const next = view_order
			? {
				tipo		: view_order.tipo,
				direction	: view_order.direction==='DESC' ? 'DESC' : 'ASC'
			  }
			: null

	// gate. Only a column the header offers (can_view_sort)
		if (next) {
			const sort_column = column && column.tipo===next.tipo
				? column
				: find_column(self.columns_map, next.tipo)
			if (!sort_column || !can_view_sort(self, sort_column)) {
				console.warn('set_view_order: not a view-sortable column of this portal:', next.tipo)
				return false
			}
		}

	// owner row lock, before the first mutation
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await set_view_order_locked(self, next)
		} finally {
			release_rows()
		}
}//end set_view_order_claimed



/**
* VIEW_ORDER_IDLE
* Whether a view order change may start now: the instance is 'rendered' (no read in
* flight — refresh refuses any other status) and no other order change holds the
* single-flight claim.
* @param {Object} self - The `component_portal` instance
* @returns {boolean}
*/
const view_order_idle = function(self) {

	return self.status==='rendered' && self.view_order_changing!==true
}//end view_order_idle



/**
* SET_VIEW_ORDER_LOCKED
* The body of `set_view_order`, run under the owner row lock.
* @param {Object} self - The `component_portal` instance
* @param {Object|null} next - The normalized view order, or null
* @returns {Promise<boolean>}
*/
const set_view_order_locked = async function(self, next) {

	// in-page flush (never prompts, never resets the page registry)
		await check_unsaved_data({
			flush_only : true
		})

	// still idle after the flush (another operation — a paginator navigate, a link —
	// may have started a read meanwhile). From here to refresh() there is no await,
	// so refresh's own status check sees this same 'rendered': a false refresh below
	// is THIS call's failed read, never someone else's read in flight
		if (self.status!=='rendered') {
			return false
		}

	// set. A new order starts from the first page
		const previous_order	= self.view_order
		const previous_offset	= self.rqo?.sqo?.offset
		self.view_order = next
		if (self.rqo?.sqo) {
			self.rqo.sqo.offset = 0
		}
		sync_view_order_sqo(self)

	// refresh. Content level: the header keeps its nodes (and the focus); the
	// edit render re-syncs the header arrows and the order indicator
		const refreshed = await self.refresh({
			destroy : false
		})
		if (refreshed!==true) {
			// restore: the instance never shows an order it did not read
			self.view_order = previous_order
			if (self.rqo?.sqo) {
				self.rqo.sqo.offset = previous_offset
			}
			sync_view_order_sqo(self)
			// usable again. A FAILED read (e.g. the server refusing the column:
			// assertViewOrder's per-hop read check, which the client gate cannot see)
			// aborts build() with status 'initialized' (common.js build_autoload), and
			// refresh() refuses every later action on a non-'rendered' instance — the
			// old rows would stay on screen, dead. Re-read under the restored order.
			if (self.status!=='rendered') {
				await reread_restored_order(self)
			}
			return false
		}


	return true
}//end set_view_order_locked



/**
* REREAD_RESTORED_ORDER
* After a failed order read: rebuild and re-render the portal under the order
* `set_view_order_locked` just restored, so it is back in status 'rendered' (the
* state every refresh-driven action requires). Runs under the caller's owner row
* lock, so it calls build/render directly (refresh would re-take the lock and
* refuses a non-'rendered' instance). When this read fails too, the instance stays
* failed, as after any other failed read.
* @param {Object} self - The `component_portal` instance
* @returns {Promise<boolean>} true when the portal is rendered again
*/
const reread_restored_order = async function(self) {

	const built = await self.build(true)
	if (built!==true || self.status!=='built') {
		console.error('set_view_order: the portal could not be re-read under the restored order:', self.tipo)
		return false
	}

	await self.render({
		render_level : 'content'
	})
	if (self.paginator) {
		self.paginator.refresh()
	}


	return self.status==='rendered'
}//end reread_restored_order



/**
* CLEAR_VIEW_ORDER
* Back to the saved order (= the declared order on a declared-order portal):
* `view_order = null` and a re-read.
* @returns {Promise<boolean>} see set_view_order
*/
component_portal.prototype.clear_view_order = async function() {

	return this.set_view_order(null)
}//end clear_view_order



/**
* SAVE_VIEW_ORDER
* "Save current order": the active TEMPORARY view order becomes the stored order,
* through the existing persisted server action `sort_by_column` (same column, same
* direction — no new write path). On success the view order clears (sort_by_column).
* Offered only when `can_save_view_order` (a view order is active, no declared order,
* write permission); refused here otherwise, with nothing sent.
* @returns {Promise<Object|false>} the sort_by_column api_response, or false
*/
component_portal.prototype.save_view_order = async function() {

	const self = this

	if (!can_save_view_order(self)) {
		return false
	}

	// single flight (see set_view_order): never saved beside a read or an order
	// change in flight — it would save the order being replaced
		if (!view_order_idle(self)) {
			return false
		}

	const {tipo, direction} = self.view_order

	self.view_order_changing = true
	try {
		return await self.sort_by_column({tipo}, direction)
	} finally {
		self.view_order_changing = false
	}
}//end save_view_order



/**
* CAN_VIEW_SORT
* Whether the list header offers the TEMPORARY sort on `column` (ui.js
* allow_column_order asks this; the one rule is drag_and_drop.js `can_view_sort`).
* @param {Object} column - A `columns_map` entry
* @returns {boolean}
*/
component_portal.prototype.can_view_sort = function(column) {

	return can_view_sort(this, column)
}//end can_view_sort



/**
* SYNC_VIEW_ORDER_SQO
* Stamps `self.view_order` on the read rqo (`sqo.view_order`), or removes it.
* Edit-mode reads only (the header that sets it lives there); the server validates
* the column (relations/order_locators.ts assertViewOrder).
* @param {Object} self - The `component_portal` instance
* @returns {void}
*/
const sync_view_order_sqo = function(self) {

	const sqo = self.rqo?.sqo
	if (!sqo) {
		return
	}

	if (self.view_order && self.mode==='edit') {
		sqo.view_order = {
			tipo		: self.view_order.tipo,
			direction	: self.view_order.direction
		}
	}else{
		delete sqo.view_order
	}
}//end sync_view_order_sqo



/**
* ECHO_HIDES_VIEW_ORDER
* Whether an injected save echo (`tmp_api_response`) would show rows in an order other
* than the active view order: the echo of a save is read in the STORED order (a save
* request carries no `sqo`), so under an edit-mode view order it must not be rendered —
* build() re-reads with the rqo instead (sync_view_order_sqo stamps `sqo.view_order`).
* Gate: test_portal_order.js (link / unlink under a view order re-read with it).
* @param {Object} self - The `component_portal` instance
* @returns {boolean}
*/
const echo_hides_view_order = function(self) {

	return Boolean(self?.view_order) && self.mode==='edit'
}//end echo_hides_view_order



/**
* FIND_COLUMN
* The columns_map entry (sub-columns included) whose tipo is `tipo`.
* @param {Array|null} columns_map
* @param {string} tipo
* @returns {Object|null}
*/
const find_column = function(columns_map, tipo) {

	for (const column of (columns_map || [])) {
		if (column?.tipo===tipo) {
			return column
		}
		const found = find_column(column?.columns_map, tipo)
		if (found) {
			return found
		}
	}

	return null
}//end find_column



/**
* GET_TOTAL
* Returns the total number of records in the portal (across all pages).
*
* `self.total` is set from `data.pagination.total` during `build()`, where the server
* provides the authoritative count alongside each data page.  No API call is needed;
* the value is already in memory.
*
* The method is async to satisfy a uniform interface across components that may need
* to compute their total asynchronously (e.g. via a count query).
*
* @returns {Promise<number|null>} The total record count, or `null` if the portal has
*                                  not been built yet.
*/
component_portal.prototype.get_total = async function() {

	const self = this

	return self.total
}//end get_total



/**
* GET_UNLINK_CHANGED_DATA
* The `changed_data` an unlink sends: one `remove` per locator, BY ITEM ID (the
* portal's stored locators carry their per-record counter id). A model whose
* entries are computed and carry no id overrides this
* (component_relation_children removes by locator).
* @param {Object[]} ar_locators - The locators to remove.
* @returns {Object[]} Frozen changed_data items.
*/
component_portal.prototype.get_unlink_changed_data = function(ar_locators) {

	return ar_locators.map(el => Object.freeze({
		action	: 'remove',
		id		: el.id,
		value	: null
	}))
}//end get_unlink_changed_data



/**
* UNLINK_RECORD
* Removes a locator from the portal by its `id` (the per-item counter id), persists
* the change via the API, and refreshes the portal.
*
* The `remove_dialog` callback is supplied as `() => true` (auto-confirm) because the
* delete confirmation was already shown to the user by the remove button handler that
* published the `initiator_unlink_<id>` event.  Passing the callback here prevents a
* second confirmation dialog from appearing.
*
* Publishes `remove_element_<id>` after the refresh so that any sibling UI elements
* (e.g. an open picker modal showing the now-unlinked record) can update themselves.
*
* If the portal is in indexation mode with an active tag filter, the filter is
* re-applied after the refresh so the display remains consistent.
*
* An ARRAY of locators may be passed instead of a single one: every id travels in
* the same `changed_data` payload, i.e. ONE save. This is what the indexation view
* needs — a row there collapses every tag anchor pointing at the same term, so
* removing them one request at a time would leave the term alive with a partial
* set of links between requests. The server removes by `id` without renumbering
* the survivors and fails the whole save on an unknown id, so a multi-id payload
* is exact and all-or-nothing.
*
* @param {Object|Object[]} locator  - The locator to remove, or an array of them.
*                                     Each must have `id` set (the portal item's
*                                     per-record counter id, not the section_id).
* @param {number|string} locator.id - Per-item counter id used to identify the entry to remove.
* @param {string} [locator.section_id] - Used only as the label in the delete dialog
*                                        (passed as `label` to `change_value`).
* @returns {Promise<boolean>} `false` if the API call fails or the user cancelled;
*                             `true` after a successful unlink and refresh.
*/
component_portal.prototype.unlink_record = async function(locator) {

	const self = this

	// owner row lock (common.js lock_rows), BEFORE the first mutation: a pending
	// editor value in this portal's rows refuses the operation here, with nothing
	// sent or changed (WC-2026-10-30-section-record-row-box)
		const release_rows = await lock_rows(self)
		if (!release_rows) {
			return false
		}
		try {
			return await unlink_record_locked(self, locator)
		} finally {
			release_rows()
		}
}//end unlink_record



/**
* UNLINK_RECORD_LOCKED
* The body of `unlink_record`, run under the owner row lock.
* @param {Object} self - The `component_portal` instance
*/
const unlink_record_locked = async function(self, locator) {

	// ar_locators. Normalise to an array so single and multi removal share one path
		const ar_locators = Array.isArray(locator)
			? locator
			: [locator]
		if (ar_locators.length===0) {
			console.warn('// unlink_record ignored empty locators');
			return false
		}

	// changed_data. Built by the overridable hook below: a model whose entries
	// carry no item id (component_relation_children) removes by locator instead.
		const changed_data = self.get_unlink_changed_data(ar_locators)

	// change_value (implies saves too)
	// The remove confirmation dialog is controlled by the button that called this function
	// (via the initiator_unlink event); supplying remove_dialog:()=>true here prevents
	// a second confirmation from appearing.
		const api_response = await self.change_value({
			changed_data	: changed_data,
			refresh			: false,
			label			: ar_locators[0].section_id,
			remove_dialog	: ()=>{
				return true
			}
		})

	// the user has selected cancel from delete dialog
		if (api_response===false || request_failed(api_response)) {
			console.warn("// unlink_record api_response failed ", api_response);
			return false
		}

	// refresh self component
		await self.refresh({
			build_autoload		: true,
			tmp_api_response	: api_response // pass api_response before build to avoid call API again
		})

	// check if the caller has active a tag_id
	// Re-apply the tag filter so the portal does not show entries from other tags.
		if(self.active_tag){
			self.node.classList.add('hide')
			// filter component data by tag_id and re-render content
			self.filter_data_by_tag_id(self.active_tag)
			.then(()=>{
				self.node.classList.remove('hide')
			})
		}

	// event to update the DOM elements of the instance
	// Allows external listeners (e.g. picker modals, sibling portals) to react
	// to the removal without polling or re-building.
	// (!) One event per removed id: listeners match a single id, so a multi-locator
	// unlink that published only the first would leave the rest stale on screen.
		for (let i = 0; i < ar_locators.length; i++) {
			event_manager.publish('remove_element_'+self.id, ar_locators[i].id)
		}


	return true
}//end unlink_record_locked



/**
* DELETE_LINKED_RECORD
* Hard-deletes a target section record that is linked in this portal, then returns
* the result of the section's `delete_section` call.
*
* This is a destructive operation distinct from `unlink_record`: it permanently
* deletes the **target record** itself (not just the portal's locator).  Calling this
* requires write/delete permission on the *target* section (REL-06), not just on the
* host record.
*
* Implementation: a lightweight section instance is spun up in 'list' mode (`id_variant:
* 'delete_section'` ensures a unique instance key so it does not collide with any
* existing editor instance for the same section_id).  The section's `delete_section`
* method handles the SQO-based record lookup, confirmation dialog, and diffusion
* propagation.  The temporary section instance is destroyed immediately after.
*
* `delete_diffusion_records` defaults to `true` (propagates to the diffusion/MariaDB
* layer) unless overridden via `self.delete_diffusion_records`.
*
* @param {Object} options                - Delete parameters.
* @param {string} options.section_tipo   - Ontology tipo of the target section.
* @param {string|number} options.section_id - Record id of the target record to delete.
* @returns {Promise<boolean|Object>} The result of `section.delete_section()`; typically
*                                    `false` if the user cancelled or `true` on success.
*/
component_portal.prototype.delete_linked_record = async function(options) {

	const self = this

	// options
		const section_id		= options.section_id
		const section_tipo		= options.section_tipo
		// const caller_dataframe	= options.caller_dataframe || null

	// delete_diffusion_records
	// Defaults to true so that deleting a linked record also cleans up its diffusion entries.
		const delete_diffusion_records = self.delete_diffusion_records ?? true

	// create the instance of the section called by the row of the portal,
	// section will be in list because it's not necessary get all data, only the instance context to be deleted it.
	// 'id_variant: delete_section' prevents collision with any live editor instance for the same record.
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


	return delete_section_result
}//end delete_linked_record



/**
* EDIT_RECORD_HANDLER
* Opens a linked target record for viewing/editing in a separate browser window.
*
* The URL and window name depend on whether the target record belongs to a Dédalo
* section or an external system (e.g. Zenon bibliographic catalog):
*
*   - **External engine** (`api_engine !== 'dedalo'`): opens `api_config.ui_base_url +
*     section_id` directly.  The portal has no way to refresh after an external-engine
*     edit, so no `on_blur` handler is registered.
*
*   - **Dédalo engine**: opens the record's edit page via `DEDALO_CORE_URL/page/?tipo=…`.
*     `session_save: false` prevents the new window from overwriting the calling
*     window's section navigation session.  The `on_blur` handler fires when the edit
*     window loses focus (i.e. the user returns to the original window) and triggers
*     a portal refresh so changes are reflected immediately.
*
* The `fn_window_blur` / `get_edit_caller` inner function climbs the caller chain to
* find the nearest edit-mode component instance to refresh.  It was deliberately limited
* to 2 levels (self → caller → caller.caller) to avoid an infinite recursion that was
* observed in some tool-hosted portal configurations (see comment dated 21-12-2023).
*
* Publishes `button_edit_click` so the mosaic-view modal can close itself when the
* user navigates to a full-screen edit.
*
* @param {Object} options              - Edit parameters.
* @param {string} options.section_tipo - Ontology tipo of the target section.
* @param {string|number} options.section_id - Record id of the target record.
* @returns {Promise<Window|undefined>} The native `Window` object of the opened window,
*                                      or `undefined` if no `engine_request_config` is
*                                      found for the given `section_tipo`.
*/
component_portal.prototype.edit_record_handler = async function(options) {

	const self = this

	// options
		const section_tipo	= options.section_tipo
		const section_id	= options.section_id

	// engine_request_config. Get current section engine
	// Determine which API engine owns this section_tipo by matching against the
	// sqo.section_tipo list in each request_config entry.
		const request_config		= self.context.request_config
		const engine_request_config	= request_config.find(el => {
			const sections_tipo = el.sqo.section_tipo.map(item => {
				return item.tipo
			})
			return sections_tipo.includes(section_tipo)
		})
		if (!engine_request_config) {
			// no engine is detected in request_config for section_tipo
			if(SHOW_DEBUG===true) {
				console.warn(')) NO engine_request_config found. edit_record_handler - section_tipo:', section_tipo);
				console.warn(')) edit_record_handler - request_config:', request_config);
			}
			return
		}

	// short vars
		let new_window

	// open window
		if (engine_request_config.api_engine!=='dedalo') {

			// external engines: zenon etc.

			// (!) THE VALIDATION OF THIS URL IS SERVER-SIDE, AND IT IS THE ONLY ONE.
			// `api_config` is cataloguing data — anyone who can edit the ontology can
			// set `ui_base_url`, and this line concatenates it into a window the
			// curator opens with one click, so a `javascript:` value was stored XSS.
			// Since 2026-08-05 the config is published through the ONE shaper,
			// src/external/config.ts publishApiConfig (both publication paths:
			// request_config[].api_config and the structure-context properties echo),
			// which refuses the WHOLE binding unless every URL is http(s), carries no
			// embedded credentials and its host is allowlisted, and which strips
			// credential-shaped keys. Gate: test/unit/external_secret_confinement_tripwire.
			// So: keep this a plain concatenation of an ALREADY-VETTED value. Do not
			// re-add a raw one from another source, and do not "fix" a rejected URL
			// here — a missing api_config means the server refused it, and the fix
			// belongs in the ontology.
			const ui_base_url = engine_request_config.api_config
				? engine_request_config.api_config.ui_base_url
				: null
			if (!ui_base_url) {
				// The server refused (or the ontology never declared) the binding.
				// Silence would open a blank window at the app's own origin; say so.
				console.warn(
					')) edit_record_handler: no api_config.ui_base_url published for external section_tipo:',
					section_tipo
				)
				return
			}

			const url = ui_base_url + section_id

			// open a new window from external source to view record
			new_window	= open_window({
				url		: url,
				name	: 'external_' + section_id
			})

		}else{

			// dedalo engine

			// open a new window from Dédalo to view/edit record
			const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
				tipo			: section_tipo,
				section_tipo	: section_tipo,
				id				: section_id,
				mode			: 'edit',
				session_save	: false, // prevent to overwrite current section session
				menu			: false
			})

			const fn_window_blur = function() {
				// refresh. Get the proper element to refresh based on some criteria.
				// Note that portals in text view are not self refresh able
				// Climbs the caller chain to find the nearest edit-mode component to refresh.
				// Capped at 2 levels to avoid infinite recursion in tool-hosted portals
				// (see removed recursive branch below, dated 21-12-2023).
				function get_edit_caller(instance) {
					if(instance && instance.mode==='edit' && instance.type==='component') {
						return instance
					}
					if(instance.caller && instance.caller.mode==='edit' && instance.caller.type==='component') {
						return instance.caller
					}
					if(instance.caller.caller && instance.caller.caller.mode==='edit' && instance.caller.caller.type==='component') {
						return instance.caller.caller
					}
					// removed 21-12-2023, it create a infinite loop in some cases as component_portal "numisdata77"
					// in numisdata_order_coins tool, when edit the original section
					// else if(instance.caller) {
					// 	return get_edit_caller(instance.caller)
					// }
					return self
				}
				const edit_caller = get_edit_caller(self)
				if (edit_caller) {
					edit_caller.refresh({
						destroy			: false,
						build_autoload	: true
					})
					.then(function(){
						// fire window_blur event
						event_manager.publish('window_blur_'+self.id, self)
					})
				}
			}//end fn_window_blur
			new_window = open_window({
				url		: url,
				name	: 'record_view_' + section_tipo +'_'+ section_id,
				on_blur : fn_window_blur
			})
		}

	// button_edit_click event. Subscribed to close current modal if exists (mosaic view case)
		event_manager.publish('button_edit_click', this)


	return new_window
}//end edit_record_handler



/**
* FOCUS_FIRST_INPUT
* No-op focus stub for the portal component.
*
* `common` calls `focus_first_input()` on the active component when the user
* activates a record.  Most components use this to move keyboard focus to their
* first text input.  Portals have no meaningful single input to focus — the
* autocomplete is opened explicitly by a button click — so this method simply
* returns `true` to satisfy the interface without changing focus.
*
* @returns {boolean} Always `true`.
*/
component_portal.prototype.focus_first_input = function() {

	return true
}//end focus_first_input



/**
* PICKER_CALLER
* The caller declaration the server derives the picker from: `{section_tipo, section_id,
* tipo}` — the ddo of THIS component, on THIS record.
*
* It replaces the client's own conclusions. The engine resolves the caller ddo, grants
* relation mode only when that ddo's resolved view is 'tree', the model is
* relation-family and the principal holds edit on it, and narrows the tree to the
* caller's own resolved target sections. No client string selects a server code path.
*
* (!) A component that names no record — a search-mode filter, a not-yet-saved row —
* cannot declare a picker: the server needs a caller ddo ON a record to resolve the
* target set and the selection cap from, and a caller missing `section_id` is refused as
* malformed (400) rather than degraded. Such a component gets NO declaration and an
* ordinary browse tree, which is what it had before the picker existed. The absence is
* reported, never silent.
*
* @param {Object} self - The `component_portal` instance (exported for the client
*                        gate test_caller_chain.js only).
* @returns {Object|null} {section_tipo, section_id, tipo[, callers]}, or null when this component
*                        names no record to declare a picker from.
*/
export const picker_caller = function(self) {

	if (!self.section_tipo || !self.tipo || self.section_id===null || self.section_id===undefined) {
		console.warn(
			'(!) [component_portal] no picker declared: the component names no record'
			+ ' {section_tipo, section_id, tipo} to derive one from. The tree opens as a plain browse.',
			{section_tipo: self.section_tipo, section_id: self.section_id, tipo: self.tipo, mode: self.mode}
		);
		return null
	}

	// callers. The component's caller chain (create_search_callers — its section
	// for a top-level one): the server opens the target thesaurus to a WRITER of
	// this component only through it, read-only, even where the user holds no
	// grant on the thesaurus (owner decision (i), src/core/security/
	// writer_chain_scope.ts). The tree's node reads carry the same declaration
	// (ts_object get_picker_caller).
	const caller = {
		section_tipo	: self.section_tipo,
		section_id		: self.section_id,
		tipo			: self.tipo
	}
	const callers = create_search_callers(self)
	if (callers) {
		caller.callers = callers
	}


	return caller
}//end picker_caller



/**
* TOGGLE_THESAURUS_PANE
* Show or hide THE picker surface for this portal: the thesaurus rendered INLINE, inside
* this component's own wrapper, beside the linked terms it feeds.
*
* THE MODEL IS tool_indexation's. That tool does not build a thesaurus and does not open
* a window: its ontology ddo_map declares an area_thesaurus, the standard element
* machinery builds and renders it into the tool's left pane, and the tool wires it with
* three assignments. Here the declaration is the component's own `view:'tree'` plus the
* target its request_config sqo already names, so the instance is obtained through the
* same machinery and mounted in a pane of this wrapper.
*
* Why inline and not a modal: a centred modal covers the very component the operator is
* filling in, so they cannot see the locator land. Keeping both on screen is what makes
* one-step picking legible — click a term, watch it appear in the list below.
*
* Nothing about the picker is decided here: the area read carries `picker_caller`, the
* SERVER answers with the mode and the constraint, and the shared picker module renders
* that answer.
*
* @returns {Promise<boolean>} true when the pane is open after the call.
*/
/**
* OPEN_PICKER_OWNER
* The portal whose thesaurus pane is currently open, or null.
*
* ONE PICKER AT A TIME, PER PAGE. Two open panes would resolve the SAME
* area_thesaurus instance — the instance key is (model, tipo, section_tipo,
* section_id, mode, lang) and none of those varies between two callers on one
* record — so the second picker would steal the first's tree, linker and
* selection state.
*
* The obvious key part, `id_variant`, is NOT usable: it CASCADES (section.js:1191
* forwards `options.id_variant || self.id_variant` to every section_record, and
* those to every component), so keying the area with it re-keys every instance
* inside the thesaurus — including the search panel's own components, which is
* what made them build wrong. A single-open rule costs the operator nothing (a
* picker is a focused act) and keeps every instance on its canonical key.
*/
let open_picker_owner = null


component_portal.prototype.toggle_thesaurus_pane = async function() {

	const self = this

	// close, when it is already open
		if (self.thesaurus_pane && !self.thesaurus_pane.classList.contains('hide')) {
			close_thesaurus_pane(self)
			return false
		}

	// ONE PICKER AT A TIME. Any other open pane is closed first — two would resolve
	// the SAME area_thesaurus instance (see open_picker_owner).
		if (open_picker_owner && open_picker_owner!==self) {
			close_thesaurus_pane(open_picker_owner)
		}

	// (!) THE TWO INPUT PATHS ARE EXCLUSIVE WHILE THE TREE IS OPEN — HIDDEN, NOT
	// DESTROYED. `activate_autocomplete`'s fast path is
	// `autocomplete_active===true → self.autocomplete.show()`, so tearing the
	// instance down leaves the component with no autocomplete on the next
	// activation. `hide()` is the reversible pair the service already uses
	// internally, so the input goes away for exactly as long as the tree is up and
	// comes straight back on close. The ontology declaration is untouched:
	// `show_autocomplete` still says the component HAS that input.
		if (self.autocomplete_active===true && typeof self.autocomplete?.hide==='function') {
			self.autocomplete.hide()
		}

	// pane. On document.body — NEVER inside self.node — placed under the component
	// by MEASURING it. The pane must not be a descendant of the component: inside
	// the wrapper the area's own drags and clicks bubble into the portal's
	// handlers (twice proven), and no amount of stopPropagation at the boundary is
	// a substitute for not being there. It is positioned from the component's
	// bounding rect instead, and re-measured on scroll/resize, so it stays flush
	// under the caller — the same geometry as the autocomplete dropdown, without
	// the parentage.
		if (!self.thesaurus_pane) {
			const pane = document.createElement('div')
			pane.classList.add('thesaurus_pane','hide')
			// A mousedown anywhere on the page deactivates the active component
			// (component_common deactivate_components, on the page's own mousedown).
			// The pane is a body child, so a click on a term would blur the very
			// component it is picking for — and the pane closes on that blur (see the
			// deactivate handler in init). Stopping mousedown at the pane keeps the
			// caller active while the operator works in the tree, exactly as the
			// autocomplete keeps it active by stopping mousedown on its own node.
			pane.addEventListener('mousedown', (event) => { event.stopPropagation() })
			document.body.appendChild(pane)
			self.thesaurus_pane = pane
		}
		const pane = self.thesaurus_pane
		pane.classList.remove('hide')
		position_thesaurus_pane(self, pane, { initial: true })

	// keep it under the component while the page moves (position only — the size
	// the operator drags to is theirs, see position_thesaurus_pane)
		self.thesaurus_pane_reposition = () => position_thesaurus_pane(self, pane)
		window.addEventListener('resize', self.thesaurus_pane_reposition)
		window.addEventListener('scroll', self.thesaurus_pane_reposition, true)

	// remember the size the operator drags the pane to, so it survives the next
	// open too. `resize: both` fires no event of its own; the ResizeObserver is the
	// one signal there is, and it also fires for the initial layout — which is
	// harmless (it records the default).
		if (!self.thesaurus_pane_resize_observer && typeof ResizeObserver!=='undefined') {
			self.thesaurus_pane_resize_observer = new ResizeObserver(() => {
				if (pane.classList.contains('hide')) {
					return
				}
				self.thesaurus_pane_size = {
					width	: pane.style.width  || `${pane.offsetWidth}px`,
					height	: pane.style.height || `${pane.offsetHeight}px`
				}
			})
			self.thesaurus_pane_resize_observer.observe(pane)
		}

	// ESC closes the picker, and closes it FIRST. Registered BEFORE the build so a
	// pane left open on a FAILED build (which shows its reason rather than hiding)
	// is closable too.
		self.thesaurus_pane_escape = (event) => {
			if (event.key!=='Escape' && event.key!=='Esc') {
				return
			}
			if (pane.classList.contains('hide')) {
				return
			}
			event.stopPropagation()
			close_thesaurus_pane(self)
		}
		document.addEventListener('keydown', self.thesaurus_pane_escape, true)

		open_picker_owner = self

	// area. Rebuilt whenever the instance is gone: it is registered in
	// self.ar_instances, so the component's own refresh() — which every successful
	// pick triggers — destroys it while this pane node survives.
		const area_alive = self.thesaurus_area
			&& self.thesaurus_area.status!=='destroyed'
			&& pane.firstChild!==null
		if (!area_alive) {
			pane.replaceChildren()
			const built = await build_thesaurus_pane(self, pane)
			if (built!==true) {
				// the pane stays OPEN: build_thesaurus_pane rendered the named reason
				// into it, and hiding it would throw that message away.
				return false
			}
		} else if (self.picker) {
			// re-opening a live tree: the caller locators may have changed underneath
			self.picker.sync_linked()
		}


	return true
}//end toggle_thesaurus_pane



/**
* CLOSE_THESAURUS_PANE
* Hide the pane and release everything it owns while open.
*
* The AREA is deliberately kept built: reopening is then instant and the tree keeps
* its expansion, scroll and search state. What must NOT survive is the document
* Escape listener, one per open, on a surface an operator opens many times over a
* record's life.
*
* @param {Object} self - The `component_portal` instance (module-private function).
* @returns {boolean} Always false — "the pane is not open".
*/
const close_thesaurus_pane = function(self) {

	const pane = self.thesaurus_pane
	if (pane) {
		pane.classList.add('hide')
	}

	if (open_picker_owner===self) {
		open_picker_owner = null
	}

	// the autocomplete gets its space back. Only when it was ACTIVE before the tree
	// opened — reviving an input the operator never activated would be a surprise,
	// and the component's own activation path owns that decision.
	if (self.autocomplete_active===true && typeof self.autocomplete?.show==='function') {
		self.autocomplete.show()
	}

	if (typeof self.thesaurus_pane_escape==='function') {
		document.removeEventListener('keydown', self.thesaurus_pane_escape, true)
		self.thesaurus_pane_escape = null
	}
	if (typeof self.thesaurus_pane_reposition==='function') {
		window.removeEventListener('resize', self.thesaurus_pane_reposition)
		window.removeEventListener('scroll', self.thesaurus_pane_reposition, true)
		self.thesaurus_pane_reposition = null
	}

	return false
}//end close_thesaurus_pane



/**
* POSITION_THESAURUS_PANE
* Place the body-level pane flush under the component by MEASURING the component.
* This is how the pane gets the autocomplete dropdown's geometry without being a
* descendant of the wrapper (which it must never be).
*
* Called on open and on every scroll/resize while open, so the pane tracks the
* caller as the page moves.
*
* POSITION IS RE-MEASURED; SIZE IS THE OPERATOR'S. `top`/`left` follow the
* component on every call. `width` and `height` are set ONCE, on open, and then
* left alone: the pane is `resize: both`, and rewriting its size on every scroll
* event threw away whatever the operator had just dragged it to — the panel
* snapped back to its default on the first scroll. A size the operator chose
* persists for as long as the pane is open, and across reopenings (kept on the
* instance).
*
* @param {Object} self - The `component_portal` instance (module-private function).
* @param {HTMLElement} pane - The pane node.
* @param {Object} [options]
*   @param {boolean} [options.initial=false] - true on open: apply the size too.
* @returns {boolean}
*/
const position_thesaurus_pane = function(self, pane, options={}) {

	const anchor = self.node
	if (!anchor) {
		return false
	}

	const rect = anchor.getBoundingClientRect()

	// position: always
	pane.style.top = `${Math.floor(rect.bottom)}px`

	// HORIZONTAL EDGE: anchor to whichever side keeps the pane ON SCREEN. Pinned to
	// the component's LEFT edge the pane is right for a component on the left of
	// the form and runs off the viewport for one on the right (the pane is wider
	// than the component: min-width, the operator's own drag). Rule: if it fits
	// growing rightwards from the component's left edge, do that; otherwise grow
	// leftwards from the component's RIGHT edge. Neither ever pushes it off-screen.
	// (the -1 keeps the pane's border flush with the component's, as before)
	const pane_width	= pane.offsetWidth || Math.floor(rect.width)
	const fits_right	= rect.left + pane_width <= window.innerWidth - 8
	if (fits_right) {
		pane.style.left		= `${Math.floor(rect.left)-1}px`
		pane.style.right	= 'auto'
	} else {
		pane.style.left		= 'auto'
		pane.style.right	= `${Math.max(8, Math.floor(window.innerWidth - rect.right)-1)}px`
	}

	// size: on open only, and never over a size the operator already chose
	if (options.initial===true) {
		const remembered = self.thesaurus_pane_size || null
		if (remembered) {
			pane.style.width	= remembered.width
			pane.style.height	= remembered.height
		} else {
			// default: the component's width; height from CSS
			pane.style.width	= `${Math.round(rect.width)}px`
			pane.style.height	= ''
		}
	}

	// keep it inside the viewport vertically, whatever its size
	const below = window.innerHeight - rect.bottom - 8
	pane.style.maxHeight = `${Math.max(160, Math.round(below))}px`

	return true
}//end position_thesaurus_pane



/**
* BUILD_THESAURUS_PANE
* Obtain the area_thesaurus instance through the STANDARD instance machinery and mount
* it in the component's pane, then wire it as this component's picker.
*
* `get_instance` is the same door every declared element goes through — it keys, caches
* and registers the instance, and `self.ar_instances` carries it so the component's own
* destroy() tears it down. Nothing here manages a lifecycle, sweeps orphans or removes
* listeners: an earlier attempt did all three, and every one of those chores was the
* price of building an area OUTSIDE this machinery.
*
* `config.picker_caller` rides init → generate_rqo → `rqo.source.caller`, which runs
* BEFORE the boot read — so the server derives mode and narrowing on the first and only
* request.
*
* @param {Object} self - The `component_portal` instance (module-private function).
* @param {HTMLElement} pane - The `.thesaurus_pane` node built by the tree view.
* @returns {Promise<boolean>} true when the pane holds a wired picker.
*/
const build_thesaurus_pane = async function(self, pane) {

	// caller declaration. Without it the server cannot grant a picker (it says why)
		const caller_declaration = picker_caller(self)
		if (!caller_declaration) {
			return false
		}

	// is_ontology. Ontology nodes (section_id '0') browse the ontology tree instead
		const is_ontology	= get_section_id_from_tipo(self.section_tipo) === '0'
		const area_tipo		= is_ontology
			? 'dd5' // ONTOLOGY_TIPO
			: 'dd100' // THESAURUS_TIPO
		const area_model	= is_ontology
			? 'area_ontology'
			: 'area_thesaurus'

	try {

		// instance. The standard door — same as any declared element
			const area = await get_instance({
				model			: area_model,
				tipo			: area_tipo,
				section_tipo	: area_tipo,
				section_id		: null,
				mode			: 'list',
				lang			: self.lang,
				caller			: self,
				// (!) NO id_variant. It is tempting — it would key the area per
				// component — but `id_variant` CASCADES: section.js:1191 forwards
				// `options.id_variant || self.id_variant` to every section_record it
				// builds, and those forward it to every component. Keying the area
				// that way therefore re-keyed every instance INSIDE the thesaurus,
				// including the search panel's own components, which then built
				// against variant keys nothing else looks them up by — the "the
				// filter's components are created badly" defect. One picker at a time
				// per page is enforced instead (see toggle_thesaurus_pane).
				config			: {
					picker_caller : caller_declaration
				}
			})
			await area.build(true)

		// (!) NOT in self.ar_instances. The area's lifetime is the PANE's, not the
		// component's refresh cycle. Every successful pick runs self.refresh(), and
		// refresh destroys ar_instances (common.refresh → destroy(dependencies)) —
		// so registering the area there killed the tree on the very click that
		// linked a term: the panel went dark after ONE pick and had to be reopened
		// for the next. The area is destroyed explicitly with the pane instead
		// (close/destroy below), which is the one lifetime it actually has.
			self.thesaurus_area = area

		// wire. The three assignments, through the shared module
			attach_picker(area, {
				linker	: self,
				caller	: self
			})

		// mount
			const area_node = await area.render()
			pane.appendChild(area_node)

	} catch (error) {
		// THE REFUSAL IS TOLD TO THE OPERATOR, not only to the console. The server
		// distinguishes "you may not browse these hierarchies" (403, generic by
		// design — it must not name what the caller cannot reach) from "this
		// component's target has no active hierarchy configured" (409, named). A
		// picker that just fails to open teaches nothing; the second case in
		// particular is an ontology configuration the operator can act on.
		console.error('Error building the thesaurus pane:', error);
		// (!) plain DOM, not ui.create_dom_element: `ui` is not imported in this
		// module, and reaching for it here threw a ReferenceError from inside the
		// very catch meant to report the failure — turning a named refusal into a
		// second, uglier crash.
		const status = error?.status ?? error?.response?.status ?? null
		const message = document.createElement('div')
		message.classList.add('thesaurus_pane_error','warning')
		message.textContent = status===409
			? (get_label.picker_no_hierarchy || 'picker_no_hierarchy')
			: status===403
				? (get_label.picker_not_authorized || 'picker_not_authorized')
				: (get_label.error || 'Error')
		pane.append(message)
		return false
	}


	return true
}//end build_thesaurus_pane



/**
* OPEN_ONTOLOGY_WINDOW
* Opens the ontology (area_ontology) or thesaurus (area_thesaurus) area in a separate
* browser window and returns a reference to it.
*
* (!) DECLARED FALLBACK, not the canonical picker surface. `open_term_picker` above is.
* This path survives for the ontology-navigation callers (which open the area to LOOK at
* a tipo, not to pick a term) and as the escape hatch when the in-page host refuses.
*
* Routing logic:
*  - If the portal's `section_tipo` has `section_id === '0'` (i.e. an ontology node),
*    the ontology area (`tipo: 'dd5'`) is opened with optional `search_tipos` to
*    highlight specific nodes.
*  - Otherwise, the thesaurus area (`tipo: 'dd100'`) is opened.
*  - The window carries NO caller declaration. It is a BROWSE surface: nothing in a
*    separately-opened area page calls attach_picker, so a caller sent here would make
*    the server grant relation mode to a tree with no picker wired onto it — every
*    node then reports "No picker is attached to this tree" and no term can be picked.
*    The picker surface is the pane (toggle_thesaurus_pane); this window is what a
*    non-tree caller, or a failed pane, opens to LOOK.
*
* (!) `thesaurus_mode`, `hierarchy_sections`, `hierarchy_terms` AND `picker_caller` are
* NOT sent, and are not to be re-added. The server derives the mode from the caller ddo and the hierarchy
* narrowing from that same caller's resolved sqo targets; a second declaration channel
* would be a fork that can disagree with the write path, and the client's
* `hierarchy_terms` shape (fixed_filter entries) was never the shape the area read
* consumes (`HierarchyTerm[]` pinned from the area node's own properties) — it was a var
* nothing could read. Related fact for anyone tempted to rebuild a target list here:
* `self.rqo.sqo.section_tipo` is FLATTENED to bare tipo strings by common.js before the
* rqo exists, so it carries no `matrix_table`; the enriched form lives in
* `self.context.request_config[…].sqo.section_tipo`.
*
* The window name `'tree_window'` is fixed so that re-clicking the button reuses the
* existing window (browser brings it to front) instead of opening a duplicate.
*
* @param {*} [retired_mode]                - RETIRED and ignored: the picker mode is
*                                           server-derived. The parameter is kept only
*                                           because callers still pass it positionally
*                                           ahead of `search_tipos`; it selects nothing.
* @param {Array<string>} [search_tipos]   - Array of ontology tipos to highlight/search in
*                                           area_ontology; ignored in area_thesaurus mode.
* @returns {Window} The native `Window` object for the opened/reused picker window.
*/
component_portal.prototype.open_ontology_window = function (retired_mode, search_tipos) {

	const self = this

	// url vars
		const url_vars = {}

		// tipo
		// Distinguish between ontology nodes (section_id='0') and thesaurus records.
		const is_ontology	= get_section_id_from_tipo(self.section_tipo) === '0'
		const tipo			= is_ontology
			? 'dd5' // ONTOLOGY_TIPO
			: 'dd100' // THESAURUS_TIPO
		url_vars.tipo = tipo

		// menu
		url_vars.menu = false

		// (!) NO picker_caller. This window is BROWSE-ONLY (see the header). Sending
		// the declaration here made the server grant relation mode to an area page in
		// which nothing wires a picker — a tree of "No picker is attached" errors.

		if (is_ontology) {

			// only for area_ontology

			url_vars.search_tipos = search_tipos
		}

		// caller_id
		// Passed to the tree window so it knows which `link_terms_<id>` event to publish
		// when the user confirms a term selection.
		const caller_id = self.id || null
		if(caller_id){
			url_vars.initiator = JSON.stringify(caller_id)
		}

	// url
	const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars(url_vars)

	// open window
	// Fixed name 'tree_window' so the browser reuses an existing window if already open.
	const tree_window = open_window({
		url		: url,
		name	: 'tree_window',
		width	: 1025,
		height	: 800
	})


	return tree_window
}//end open_ontology_window



/**
* IS_EMPTY
* Returns whether the portal currently has no linked entries.
*
* Used primarily in search mode: when the portal is part of an SQO filter, the
* component wrapper receives an 'active' / highlighted CSS class only when the user
* has picked at least one locator.  `is_empty` drives that highlight logic.
*
* Checks `this.data.entries.length` first (the fast path), then verifies that
* `entries[0]` is truthy as a safety guard against sparse arrays or entries containing
* falsy stub values.
*
* Note: only the currently loaded pagination page is inspected; an empty page does
* not necessarily mean the full portal dataset is empty across all pages.
*
* @returns {boolean} `true` if the portal has no entries on the current page;
*                    `false` if at least one entry exists and is truthy.
*/
component_portal.prototype.is_empty = function() {

	const entries = this.data?.entries || []

	if(entries.length === 0) {
		return true
	}

	// Double check first entry exists (safety)
	if(entries[0]) {
		return false
	}

	return true
}//end is_empty



// @license-end
