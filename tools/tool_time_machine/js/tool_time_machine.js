// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* TOOL_TIME_MACHINE (module)
*
* Client-side controller for the Time Machine tool — a history-viewer and
* value-restorer that lets users browse every past state of a component (or
* an entire section) that was saved to the `matrix_time_machine` table, and
* optionally restore any snapshot to the live record.
*
* Architecture overview
* ---------------------
* The tool is opened as a floating modal or detached window from a section's
* toolbar, with `caller` pointing to the component (or section) whose history
* is being inspected.  The tool instantiates one `tm_list` — a
* paginated list of all historical snapshots, sorted by `timestamp DESC`.
* When the user clicks the eye icon on a list row the dd15 list view publishes
* the `tm_edit_record` event (see `core/section/js/view_tm_list_section.js`); the tool
* subscribes, loads the historical snapshot through `get_component()`, renders
* it in the preview pane, and enables the "Apply and save" button.
*
* Pressing "Apply and save" calls `apply_value()` which posts an
* `apply_value` tool_request to `dd_tools_api`; the server handler overwrites
* the live data and logs the restore in the activity log.
*
* Bulk-process support
* --------------------
* When a TM row belongs to a bulk operation (`bulk_process_id` is set) a
* "Revert bulk process" button becomes visible.  Only global-admins can
* execute the revert; regular users see an advisory message directing them
* to contact an admin.  The revert is dispatched via `bulk_revert_process()`.
*
* Prototype inheritance
* ---------------------
*   render   ← tool_common.prototype.render
*   refresh  ← common.prototype.refresh
*   destroy  ← common.prototype.destroy
*   edit     ← render_tool_time_machine.prototype.edit
*
* Key instance properties (set at construction time)
* ---------------------------------------------------
*   tm_list   — {Object|null}   the tm_list instance
*   selected_matrix_id     — {number|null}   TM row PK chosen by the user
*   button_apply           — {HTMLElement}   "Apply and save" button DOM node
*   preview_component_container — {HTMLElement} container for the TM snapshot
*   caller                 — {Object}        the component/section that opened the tool
*   caller_dataframe       — {Object|null}   dataframe context forwarded to apply_value
*   selected_bulk_process_id — {number|null} bulk-process id of the selected row
*
* (!) SHOW_DEVELOPER is declared in core/common/js/environment.js.php and is
* NOT listed in the file-level /*global*\/ directive above; usages in
* apply_value() and bulk_revert_process() will trigger eslint no-undef.
*
* Exports: {tool_time_machine}
*/

// import
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {clone, dd_console} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {response_data} from '../../../core/common/js/api_error.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {tool_common, load_component} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_time_machine, add_component} from './render_tool_time_machine.js'
	import {ui} from '../../../core/common/js/ui.js'



// Below this width the version panels STACK above the list
// (tool_time_machine.less keys its phone block on `@width_break_point_0`), so a
// row tapped below the fold needs the preview pane revealed. Must match that
// media query.
const STACKED_LAYOUT_MAX_VIEWPORT = 1024



/**
* TOOL_TIME_MACHINE
* Constructor for the Time Machine tool instance.
*
* Initialises all instance properties to their null/empty defaults.
* The actual data is populated during `init()` and `build()`.
*
* Properties shared with tool_common / common:
*   @var {string|null}  id              - Unique instance identifier (set by tool_common.init)
*   @var {string|null}  model           - Always 'tool_time_machine'
*   @var {string|null}  mode            - Render mode ('edit', 'list', etc.)
*   @var {string|null}  lang            - Active language code (e.g. 'lg-spa'); inherited from caller
*   @var {HTMLElement|null} node        - Root DOM node after render
*   @var {Array|null}   ar_instances    - Child component/service instances managed by this tool
*   @var {string|null}  status          - Lifecycle status token
*   @var {Array}        events_tokens   - Subscription tokens returned by event_manager.subscribe;
*                                         used to unsubscribe on destroy()
*   @var {string|null}  type            - DDO type identifier
*
* Properties specific to tool_time_machine:
*   @var {Object|null}      caller               - The component or section instance that opened the tool
*   @var {Object|null}      tm_list - Loaded tm_list instance (paginated list)
*   @var {HTMLElement|null} button_apply         - "Apply and save" button; shown after user selects a row
*   @var {number|null}      selected_matrix_id   - PK of the currently selected TM row (dd1573 value)
*   @var {HTMLElement|null} modal_container      - Container node when the tool is opened as a modal
*                                                  (unused in the current implementation — reserved)
*/
export const tool_time_machine = function () {

	this.id						= null
	this.model					= null
	this.mode					= null
	this.lang					= null
	this.node					= null
	this.ar_instances			= null
	this.status					= null
	this.events_tokens			= []
	this.type					= null

	this.caller					= null
	this.tm_list	= null
	this.button_apply			= null
	this.selected_matrix_id		= null
	this.modal_container		= null
}//end tool_time_machine



/**
* COMMON FUNCTIONS
* Extend tool_time_machine with shared lifecycle and render methods.
*
* Assignments:
*   render  — tool_common.prototype.render  : handles wrapper creation and
*             delegates to this.edit() for content assembly
*   refresh — common.prototype.refresh      : rebuilds and re-renders without
*             full destroy; used when the user switches lang in the selector
*   destroy — common.prototype.destroy      : unsubscribes event tokens stored
*             in this.events_tokens, removes DOM node, clears ar_instances
*   edit    — render_tool_time_machine.prototype.edit : assembles the full
*             content_data layout (current + preview panes, toolbar, TM list)
*/
// prototypes assign
	tool_time_machine.prototype.render	= tool_common.prototype.render
	tool_time_machine.prototype.refresh	= common.prototype.refresh
	tool_time_machine.prototype.destroy	= common.prototype.destroy
	tool_time_machine.prototype.edit	= render_tool_time_machine.prototype.edit



/**
* INIT
* Initialises the tool instance state and subscribes to the cross-component
* event that drives the preview pane.
*
* Execution order:
*   1. Calls tool_common.prototype.init to load context, ddo_map, labels, and
*      reconstruct the caller reference (including the new-window path).
*   2. Copies `dedalo_projects_default_langs` from page_globals for the lang
*      selector rendered in `get_content_data`.
*   3. Inherits the active language from the caller component (null when opened
*      on a section, which has no meaningful single lang).
*   4. Subscribes to `tm_edit_record` — published by
*      `core/section/js/view_tm_list_section.js` whenever the user clicks the eye icon
*      on a history row.  The handler loads the historical snapshot, renders it
*      in the preview pane, updates `selected_matrix_id`, and shows/hides the
*      apply and bulk-revert controls.
*
* Bulk-process handling inside the handler:
*   - When `data.bulk_process_id` is truthy the row belongs to a batch
*     operation.  Global admins see the operation label fetched via
*     `get_bulk_process_label()`; other users see a static advisory message.
*   - When `data.bulk_process_id` is falsy the bulk-revert controls are hidden
*     and `selected_bulk_process_id` is cleared.
*
* @param {Object} options - Initialisation options forwarded to tool_common.prototype.init
* @returns {Promise<boolean>} Resolves with the value returned by tool_common.prototype.init
*/
tool_time_machine.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	// fix dedalo_projects_langs
		self.langs = page_globals.dedalo_projects_default_langs

	// fix lang from caller
		self.lang = self.caller && self.caller.lang
			? self.caller.lang
			: null

	// events subscribe. Published when user clicks on list record eye icon (preview)
		const fn_tm_edit_record = async function(data) {

			const matrix_id = data.matrix_id
			// Render the timestamp component in text mode to obtain a human-readable label
			const modification_component_date = data.modification_component_date
			modification_component_date.view = 'text'
			const label = (await modification_component_date.render()).textContent;

			// render. Create and add new component to preview container
			// The preview pane is the ONE place a Time Machine component is loaded
			// EDITABLE-shaped: get_component overlays {mode:'edit', data_source:'tm'}
			// and the render is then forced read-only. `data_source` — not a render
			// mode — is what makes it read the matrix_time_machine row; the mode
			// argument here has always been ignored (get_component hardcodes 'edit'),
			// so it is no longer passed. Named exemption to the "dd15 never emits
			// mode 'edit'" rule, see WC-2026-08-14-tm-ddo-mode-retired.
			add_component(
				self,
				self.preview_component_container,
				self.lang,
				label,
				null,
				matrix_id
			)

			// fix selected matrix_id
			self.selected_matrix_id = matrix_id
			// show Apply button
			self.button_apply.classList.remove('hide','lock')

			// bulk process remove the hide when the selected row has a bulk_process_id
			// only global_admin can use it.
			// if user pick a row with bulk_process_id it will show a message.
			if( data.bulk_process_id ){
				self.selected_bulk_process_id = data.bulk_process_id
				if( self.button_bulk_revert_process ){
					self.button_bulk_revert_process.classList.remove('hide','lock')
				}

				// Global admins see the actual process label; everyone else gets an advisory.
				const label_bulk_revert_text = ( page_globals.is_global_admin === true )
					? await self.get_bulk_process_label({
						bulk_process_id : data.bulk_process_id
					})
					: self.get_tool_label('info_revert_bulk_process') || 'To revert this bulk process contact an administrator.'


				self.label_bulk_revert_process.innerHTML = label_bulk_revert_text


				self.label_bulk_revert_process.classList.remove('hide','lock')
			}else{
				// Row has no bulk_process_id — clear bulk controls
				self.selected_bulk_process_id = null
				self.button_bulk_revert_process.classList.add('hide','lock')
				self.label_bulk_revert_process.classList.add('hide','lock')
			}

			// PHONE WIDTH. Long history: the row the user tapped is below the
			// fold, so the version just picked — and the Apply button under it —
			// is off screen. Bring the preview pane to the top of the view.
			if (window.innerWidth <= STACKED_LAYOUT_MAX_VIEWPORT) {
				// The tool header is STICKY at this width (tool_responsive.less),
				// so a plain reveal lands the pane behind it. scrollIntoView
				// honours scroll-margin-top (the mechanism update_code uses) and
				// the header height is not a constant — the title wraps — so it
				// is measured.
				const tool_header = self.preview_component_container
					.closest('.wrapper_tool')?.querySelector('.tool_header')
				if (tool_header) {
					self.preview_component_container.style.scrollMarginTop =
						`${tool_header.getBoundingClientRect().height}px`
				}
				ui.reveal(self.preview_component_container, { block: 'start' })
			}
		}//end fn_tm_edit_record
		self.events_tokens.push(
			event_manager.subscribe('tm_edit_record', fn_tm_edit_record)
		)


	return common_init
}//end init



/**
* BUILD (CUSTOM)
* Extends tool_common.prototype.build with Time Machine-specific setup:
* loading the main element (component or section being inspected) and wiring
* up the `tm_list` instance that renders the history list.
*
* Step-by-step:
*   1. Lang sync on ddo_map — before calling common build, iterate each entry
*      and update any translatable item's lang to `self.lang`.  This is
*      required on refresh-triggered rebuilds (lang switch) so the tool does
*      not request data in the wrong language.
*   2. Call tool_common.prototype.build — loads all ddo_map items via the API
*      and initialises child instances except 'section' model items (which
*      tool_common skips; see step 3).
*   3. Section special-case — when the main_element ddo has model='section'
*      the section instance is not created by tool_common, so build creates it
*      here manually with `get_instance` + `build(true)`.
*   4. Locate `main_element` in ar_instances by tipo match.
*   5. Build the `ddo_map` for tm_list:
*        - For a component target: a single synthetic ddo in list mode.
*        - For a section target: the section's own `request_config_object.show.ddo_map`
*          (which lists all components belonging to that section).
*   6. Compute `ignore_columns` — for section targets the 'where' column (dd577)
*      is suppressed because a section restore does not have a single component
*      address to display.
*   7. Instantiate `tm_list` via `get_instance` and build it with
*      autoload=true.  Throws a string on failure so the catch block surfaces
*      the error through `self.error` without crashing the caller.
*   8. Force `caller_is_calculated = false` to prevent the new-window
*      reconstructed caller from being reused on the next lang-switch refresh
*      (which would recreate instances with stale context).
*
* @param {boolean} [autoload=false] - Passed through to tool_common.prototype.build
*                                     to control whether ddo_map items are
*                                     auto-fetched on first load
* @returns {Promise<boolean>} Resolves with the value from tool_common.prototype.build
*/
tool_time_machine.prototype.build = async function(autoload=false) {

	const self = this

	// ddo_map. Update ddo_map elements lang before common build
		// Note that when user switch lang from tool lang selector, we need refresh whole tool
		// re-building ddo_map from tool_common. To prevent re-create the first ddo_map items
		// it its necessary to update the items lang before (only for translatable elements)
		self.tool_config.ddo_map = self.tool_config.ddo_map || []
		const ddo_map_length = self.tool_config.ddo_map.length
		for (let i = 0; i < ddo_map_length; i++) {
			const item = self.tool_config.ddo_map[i]
			// Only update items with an explicit lang; nolan items carry lang-neutral data
			if (item.lang && item.lang!==page_globals.dedalo_data_nolan) {
				item.lang = self.lang
			}
		}

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(self, autoload);

	// tm_list
		try {

			// fix main_element for convenience
				const main_element_ddo	= self.tool_config.ddo_map.find(el => el.role==='main_element')

			// section case. (!) note that section is not loaded automatically from tool common build
				if (main_element_ddo.model==='section') {
					const section_options = {
						model			: main_element_ddo.model,
						mode			: main_element_ddo.mode,
						tipo			: main_element_ddo.tipo,
						section_tipo	: main_element_ddo.section_tipo,
						section_id		: main_element_ddo.section_id,
						lang			: main_element_ddo.lang,
						type			: main_element_ddo.type,
						properties 		: main_element_ddo.properties || null,
						id_variant		: self.model,  // id_variant prevents id conflicts
						caller			: self // set tool as caller of the element :-)
					}
					const instance = await get_instance(section_options) // load and init
					await instance.build(true)
					self.ar_instances.push(instance)
				}

			// fix main_element
				self.main_element = self.ar_instances.find(el => el.tipo===main_element_ddo.tipo)
				if (!self.main_element) {
					console.error('Error: main_element_ddo not found in self.ar_instances', self.ar_instances)
				}

			// THE TIME MACHINE LIST IS AN ORDINARY SECTION LIST.
			// It is a `section` instance pointed at dd15, exactly like the one
			// tool_cataloging / tool_identify / tool_user_admin build for their own
			// targets — no private list service any more
			// (WC-2026-08-14-tm-scope-server-owned).
			//
			// What used to be hand-built client-side and mirrored back by the server
			// is now DERIVED SERVER-SIDE from the SQO's scope: the column set, each
			// column's view, and the debug snapshot column. So this passes NO
			// ddo_map. It passes the SQO, because the SQO is the request.
				const caller_section_tipo	= self.caller.section_tipo
				const caller_section_id		= self.caller.section_id
				const is_section_caller		= self.main_element.model==='section'

			// sqo
			// (!) `mode:'tm'` is the ROW SOURCE — it routes the read to
			// matrix_time_machine instead of the caller section's own table. It is
			// NOT a render mode (that one is retired) and must never be 'list':
			// that returns the section's LIVE records instead of its history,
			// silently and with no error.
				const sqo = {
					id			: 'time_machine_temporal',
					mode		: 'tm',
					section_tipo: [caller_section_tipo],
					limit		: 10,
					offset		: 0,
					order		: [{
						direction	: 'DESC',
						path		: [{ component_tipo : 'id' }]
					}],
					skip_projects_filter : true
				}
				if (is_section_caller) {
					// Whole-record snapshots of this section: WHERE tipo = section_tipo.
					sqo.filter = { $and : [{ q : caller_section_tipo, column_name : 'tipo' }] }
				}else{
					// One component of one record.
					sqo.filter_by_locators = [{
						section_tipo	: caller_section_tipo,
						section_id		: caller_section_id,
						tipo			: self.main_element.tipo,
						lang			: self.main_element.lang
					}]
				}

			// section instance (dd15)
				const instance_options = {
					model			: 'section',
					tipo			: 'dd15',
					section_tipo	: 'dd15',
					mode			: 'list',
					// routes render to section/js/view_tm_list_section.js, whose only
					// override is the Id-cell restore/preview action
					view			: 'tm_list',
					lang			: self.main_element.lang,
					// record identity in the key: get_instance returns cached
					// instances ignoring fresh options, so opening the tool on
					// another record must resolve a DIFFERENT key
					id_variant		: self.main_element.tipo +'_'+ caller_section_tipo +'_'+ caller_section_id +'_'+ self.model,
					caller			: self,
					// An EMBEDDED panel: no section toolbar, no search panel. The
					// section renders those for a full page; inside a tool they are
					// neither wanted nor meaningful (this list is consultation-only).
					buttons			: false,
					filter			: false,
					// never persist the tool's filter into the shared dd15 session —
					// the standalone dd15 browse would merge it back
					session_save	: false,
					request_config	: [{
						api_engine	: 'dedalo',
						type		: 'main',
						sqo			: sqo,
						show		: {}
					}]
				}

				self.tm_list = await get_instance(instance_options)

			// view
			// Set explicitly rather than relying on the options hop: dd15's section
			// context declares no view of its own, and render_list_section falls back
			// to self.view only when the context is silent. Without this the list
			// renders through view_default_list_section and the Id cell loses its
			// restore/preview action.
				self.tm_list.view = 'tm_list'

			// build the list
				const build_result = await self.tm_list.build(true)
				if (!build_result) {
					throw 'Invalid time machine list build. See server log for details.'
				}

			// add to self instances list
				self.ar_instances.push(self.tm_list)

			// (!) force self.caller_is_calculated as false to avoid to re-use calculated
			// component instances on lang change
				self.caller_is_calculated = false

		} catch (error) {
			self.error = error
			console.error(error)
		}


	return common_build
}//end build



/**
* HISTORY_LANG
* The language lane the main element's history lives in — the lane the
* restore confirm names and whether a language selector means anything.
*
* The SERVER states it (dd15 context `tm_main.lang_sliced`, read_tm.ts
* tmMainLaneLaw) — never re-derived here: a main whose data is not
* lang-sliced (every relation model, whatever its ontology `translatable`
* flag) has ONE lane, 'lg-nolan', and a restore replaces its whole value and
* frames. Otherwise the main element's own lang.
*
* @returns {string} 'lg-nolan' or the main element's lang
*/
tool_time_machine.prototype.history_lang = function() {

	const self = this

	const lang = self.main_element?.lang || 'lg-nolan'
	const tm_main = self.tm_list?.context?.tm_main
	if (tm_main && tm_main.tipo===self.main_element?.tipo && tm_main.lang_sliced===false) {
		return 'lg-nolan'
	}

	return lang
}//end history_lang



/**
* GET_COMPONENT
* Creates and returns a component instance loaded with data from a specific
* `matrix_time_machine` row, to be placed in the preview pane.
*
* The new instance is built from a deep clone of `self.main_element.context`
* so that the original live component is not mutated.  The clone is then
* augmented with:
*   - `matrix_id`    — TM row PK (dd1573); signals the API to read from
*                      `matrix_time_machine` instead of the regular table.
*   - `data_source: 'tm'` — forwarded into the source object by `create_source`
*                      so the server-side reader knows to query TM storage.
*   - `mode: 'edit'` — forced to 'edit' regardless of the `mode` argument;
*                      the render step later sets permissions=1 (read-only).
*   - `to_delete_instances` — any previous TM-preview instances with the same
*                      tipo and ANOTHER matrix_id are destroyed DEEP inside
*                      `load_component` (`delete_dependencies:true`), so neither
*                      they nor their subtree (section_records, dataframes, with
*                      that row's data) stay in `ar_instances` / the instances
*                      map. The instance of the requested row itself is never
*                      listed: re-clicking the same row returns it from the
*                      instances cache, and destroying it would destroy the very
*                      instance about to be (re)built.
*
* (!) The `mode` parameter is accepted but overridden by the hardcoded
* `'edit'` value in the options object.  This was intentional (force edit
* context for proper rendering) but may be surprising to callers.
*
* @param {string}       lang      - Language code to request data in (e.g. 'lg-spa')
* @param {string}       mode      - Requested render mode (currently overridden to 'edit' internally)
* @param {number|null}  [matrix_id=null] - PK of the `matrix_time_machine` row to preview;
*                                          null is only valid for the current-value pane
* @returns {Promise<Object>} Resolves with the loaded component instance
*/
tool_time_machine.prototype.get_component = async function(lang, mode, matrix_id=null) {

	const self = this

	// to_delete_instances. Select instances with same tipo and another, not empty, matrix_id
		// Collect the superseded TM-preview instances so load_component can remove them
		// (avoids accumulating ghost instances in ar_instances). The requested row's own
		// instance is excluded: get_instance serves it from cache on a same-row re-click,
		// so listing it would destroy the instance load_component is about to build.
		const to_delete_instances = self.ar_instances.filter(el =>
			el.tipo===self.main_element.tipo
			&& el.matrix_id
			&& String(el.matrix_id)!==String(matrix_id)
		)

	// instance_options (clone context and edit)
		// Clone main_element.context so the live component is not mutated,
		// then overlay TM-specific options.
		const options = Object.assign(clone(self.main_element.context), {
			self				: self,
			lang				: lang,
			mode				: 'edit', // mode,
			section_id			: self.main_element.section_id,
			matrix_id			: matrix_id,
			data_source			: 'tm',
			to_delete_instances	: to_delete_instances, // array of instances to delete after create the new on
			// deep destroy, scoped to this tool (load_component's shared default stays shallow):
			// a preview subtree is keyed by its matrix_id and belongs to nothing else
			delete_dependencies	: true
		})

	// call generic common tool build
		const component_instance = await load_component(options);


	return component_instance
}//end get_component



/**
* APPLY_VALUE
* Sends a tool_request to `dd_tools_api` asking the server to overwrite the
* live component data with the historical snapshot identified by `matrix_id`.
*
* The server-side handler (`apply_value`, `tools/tool_time_machine/server/tool_time_machine.ts`) will:
*   - Read the `matrix_time_machine` row for `matrix_id`.
*   - Write that data back to the live component (or section) via `set_data`
*     + `save()`.
*   - Log the restore as a RECOVER COMPONENT/SECTION activity entry.
*   - Write the restore's own history row (a section recover writes a whole-record
*     row); the TM row that was just restored is kept.
*
* Dataframe context: when `self.caller_dataframe` is set (the tool was opened
* on a dataframe-paired component), it is forwarded so the server handler can
* correctly route the restore to the right dataframe slot.
*
* Timeout is intentionally generous (60 s) because section restores can
* involve a large number of components.
*
* (!) SHOW_DEVELOPER is a page-global not listed in the file /*global*\/ annotation;
* references on line 368 will produce an eslint no-undef warning at lint time.
*
* @param {Object} options              - Restore parameters
* @param {number} options.section_id  - Section ID of the live record to restore into
* @param {string} options.section_tipo - Section tipo of the live record
* @param {string} options.tipo        - Component tipo being restored (equals section_tipo for section restores)
* @param {string} options.lang        - Language code of the data to restore
* @param {number} options.matrix_id   - PK of the `matrix_time_machine` row containing the snapshot
* @returns {Promise<Object>} Resolves with the envelope v2 response object
*                            ({ok: boolean, request_id: string, data: true} on success;
*                            a section restore adds restore_deleted_section_media_files)
*/
tool_time_machine.prototype.apply_value = function(options) {

	const self = this

	// options
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo
		const tipo			= options.tipo
		const lang			= options.lang
		const matrix_id		= options.matrix_id

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'apply_value')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				section_id		: section_id,
				section_tipo	: section_tipo,
				tipo			: tipo,
				lang			: lang,
				matrix_id		: matrix_id
			}
		}
		// dry_run: the server runs the restore, rolls it back and answers {changed}
		if (options.dry_run===true) {
			rqo.options.dry_run = true
		}

	// dataframe caller
		// Forward the dataframe context so the server handler routes the restore
		// to the correct dataframe slot when the component is dataframe-paired.
		if (self.caller_dataframe) {
			rqo.options.caller_dataframe = self.caller_dataframe
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo,
				retries : 1, // one try only
				timeout : 60 * 1000, // 60 secs waiting response
				// 'caller': the Apply button renders them itself (the window may close on success)
				notices	: options.notices || 'page'
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> apply_value API response:",'DEBUG',response);
				}

				resolve(response)
			})
		})
}//end apply_value



/**
* BULK_REVERT_PROCESS
* Sends a tool_request to revert ALL changes that belong to a previous bulk
* operation identified by `bulk_process_id`.
*
* This is a potentially long-running, wide-scope operation: the server handler
* (`tools/tool_time_machine/server/bulk_revert.ts`) replays the run's UNDO LOG
* (WC-2026-09-27-bulk-revert-undo-log): every save of the run recorded the exact
* region it replaced (a hidden BEFORE row) next to its visible after-row, so each
* key is restored to that region — unless it changed after the run
* (`changed_since_run`), in which case it is left alone and reported. A run
* recorded before the undo log is reverted by inference from the history and
* listed in `inexact[]`. A run still writing is refused.
*
* The operation is recorded as a new bulk-process entry in the
* `DEDALO_BULK_PROCESS_SECTION_TIPO` (dd800) section so that this revert is
* itself reversible via a subsequent bulk_revert_process call.
*
* Access control: only global admins can trigger the bulk-revert UI button
* (enforced in `render_tool_time_machine`), but the server enforces its own
* per-row permission check (level 2 on the (section_tipo, tipo) pair AND
* per-record project scope). Keys the caller cannot write are skipped and
* COUNTED in `response.data.skipped[]` as `{reason:'out_of_scope'}` — with no
* coordinates, since the batch may name records outside the caller's scope
* (SEC-16, WC-2026-09-03-bulk-revert-skipped-typed-entries). Every other
* skipped entry (`changed_since_run`, `interleaved_write`, `created_record_kept`,
* `cascade_delete_not_reverted`, `no_pre_batch_state`, `no_column`,
* `no_lang`, `failed`) carries its coordinates; the words
* behind a refusal are in the server log, never on the wire. The renderer shows
* the whole payload to the admin before closing (bulk_revert_summary_message).
*
* Timeout is set to 180 s to accommodate very large bulk processes spanning
* hundreds of records.
*
* (!) SHOW_DEVELOPER is a page-global not listed in the file /*global*\/ annotation;
* the reference on line 425 will produce an eslint no-undef warning at lint time.
*
* Note: the `options` property key is `selected_bulk_process_id` (not
* `bulk_process_id`); the local variable `bulk_process_id` is read from
* `options.selected_bulk_process_id` — callers must use that key name.
*
* @param {Object} options                          - Revert parameters
* @param {number} options.section_id              - Section ID of the record that opened the tool
* @param {string} options.section_tipo            - Section tipo of the record
* @param {string} options.tipo                    - Component tipo of the record
* @param {string} options.lang                    - Active language code
* @param {number} options.selected_bulk_process_id - The bulk_process_id (dd1371) to revert
* @param {string} options.bulk_revert_process_label - Human-readable name logged as the new process label
* @returns {Promise<Object>} Resolves with the envelope v2 response: on success
*                            `data` is `{counter, unchanged, bulk_process_id,
*                            exact, skipped, inexact}`;
*                            a refusal carries the coded `error` and no data
*/
tool_time_machine.prototype.bulk_revert_process = function(options) {

	const self = this

	// options
		const section_id				= options.section_id
		const section_tipo				= options.section_tipo
		const tipo						= options.tipo
		const lang						= options.lang
		// (!) The key is 'selected_bulk_process_id', not 'bulk_process_id'
		const bulk_process_id			= options.selected_bulk_process_id
		const bulk_revert_process_label	= options.bulk_revert_process_label

	// source. Note that second argument is the name of the function to manage the tool request like 'revert_process'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'bulk_revert_process')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				section_id					: section_id,
				section_tipo				: section_tipo,
				tipo						: tipo,
				lang						: lang,
				bulk_process_id				: bulk_process_id,
				bulk_revert_process_label	: bulk_revert_process_label
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo,
				retries : 1, // one try only
				timeout : 180 * 1000 // 180 secs waiting response
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> bulk revert_process API response:",'DEBUG',response);
				}

				resolve(response)
			})
		})
}//end bulk_revert_process



/**
* GET_BULK_PROCESS_LABEL
* Fetches the human-readable label string stored in the bulk-process section
* (dd800) for the given `bulk_process_id`.
*
* The bulk-process section (DEDALO_BULK_PROCESS_SECTION_TIPO = 'dd800') stores
* one record per bulk operation, where:
*   - section_id  = bulk_process_id (the PK doubles as the record id)
*   - dd796       = DEDALO_BULK_PROCESS_LABEL_TIPO, a component_input_text that
*                   holds the operation's human-readable name
*
* The method bypasses tool_request and calls `dd_core_api` directly with
* action='read' and a manually constructed source object, because the label
* lives in a standard core component — no tool-specific dispatch is needed.
*
* The source object here is built inline rather than through `create_source()`
* because this reads a different section/component than the one the tool is
* managing; `create_source()` would populate the wrong tipo/section_tipo.
*
* (!) SHOW_DEVELOPER is a page-global not listed in the file /*global*\/ annotation;
* the reference on line 710 will produce an eslint no-undef warning at lint time.
*
* @param {Object} options                    - Options
* @param {number} options.bulk_process_id    - The bulk-process id (dd1371 value); used
*                                             as both the filter value and as section_id
*                                             when reading the dd800 record
* @returns {Promise<string|null>} Resolves with the label text, or null/false when
*                                 the record is not found or the API call fails
*/
tool_time_machine.prototype.get_bulk_process_label = async function(options){

	const self = this

	const bulk_process_id	= options.bulk_process_id
	// dd800 = DEDALO_BULK_PROCESS_SECTION_TIPO; dd796 = DEDALO_BULK_PROCESS_LABEL_TIPO
	const section_tipo		= 'dd800'
	const component_tipo	= 'dd796'

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		// (!) source is built inline — not via create_source() — because we are
		// reading from a different section (dd800) than the tool's own target.
		const source = {
			typo			: 'source',
			type			: 'component',
			action			: 'get_value',
			tipo			: component_tipo,
			section_tipo	: section_tipo,
			section_id		: bulk_process_id,
		}

	// rqo
		const rqo = {
			dd_api	: 'dd_core_api',
			action	: 'read',
			source	: source
		}

	// call to the API, fetch data and get response
		const api_response = await data_manager.request({
			body : rqo
		})
		if(SHOW_DEVELOPER===true) {
			console.log("-------------> get_value:",'DEBUG', response_data(api_response));
		}


	// Returns the raw result value: a string label, or null/false on failure
	return response_data(api_response)
}//end get_bulk_process_label



// @license-end
