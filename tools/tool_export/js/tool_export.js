// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals*/
/*eslint no-undef: "error"*/



/**
* TOOL_EXPORT
*
* Top-level controller for the Dédalo v7 data-export tool.
*
* Responsibilities:
* - Owns the instance state: the user's selected columns (`ar_ddo_to_export`),
*   the active SQO (filter), and the CURRENT EXPORT (a server job — see the
*   "SERVER-BUILT EXPORT" block below: the browser never holds the export).
* - Delegates rendering to `render_tool_export` (edit / pager / downloads /
*   build_export_component / sync_ar_ddo_to_export), drag-and-drop to
*   `drag_tool_export`, and generic lifecycle to `common`/`tool_common`.
* - Owns the export runtime's LIFETIME: `job_followers` (every job stream this
*   tool opens), `export_timers`, `export_raf` and `export_abort` (in-flight
*   preview requests) — all released by `reset_export_runtime()` on destroy and
*   on every new Export click.
* - Persists the user's column selection per `target_section_tipo` to IndexedDB
*   (`update_local_db_data`) so it survives page reloads.
*
* Key state:
*   - `self.ar_ddo_to_export`   – ordered array of DDO objects for selected columns
*   - `self.sqo`                – the caller section's search query object (cloned for export)
*   - `self.target_section_tipo`– the section being exported (may differ from caller)
*   - `self.export_state`       – the current export {job_id, status, pfile, …} (render_tool_export)
*
* Main exports: `tool_export` (constructor).
* See: tools/tool_export/server/ (index.ts actions, export_job.ts, preview.ts),
*      tools/tool_export/js/render_tool_export.js,
*      tools/tool_export/js/flat_table.js (page renderer).
*/

// import
	import {clone} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
	import {create_job_follower_group} from '../../../core/common/js/job_follow.js'
	import {render_tool_export} from './render_tool_export.js'
	import {
		on_dragstart,
		on_dragend,
		on_dragover,
		on_dragleave,
		on_drop,
		set_sort_payload
	} from './drag_tool_export.js'
	import {
		on_component_row,
		add_export_component_from_row,
		move_export_component,
		update_phone_reorder_state
	} from './phone_tool_export.js'



/**
* TOOL_EXPORT
* Constructor: initialises all instance properties to their zero/sentinel values.
*
* Properties set here are the authoritative list; `init()` fills them with real
* data from `options` and the caller section. Keeping them here makes it easy
* to audit state at construction time.
*/
export const tool_export = function () {

	this.id					= null
	this.model				= null
	this.mode				= null
	this.node				= null
	this.ar_instances		= null
	this.status				= null
	this.events_tokens		= []
	this.type				= null
	this.source_lang		= null
	this.caller				= null // section or component
	this.components_list	= {}
	this.data_format		= null
	// media_components. Set of grid data existing media components (used to export media)
	// e.g. new Set(['component_image']);
	this.media_components	= new Set([
		'component_3d',
		'component_av',
		'component_image',
		'component_pdf',
		'component_svg'
	]);
	// media_components_in_data. Array of media components in data (used to export media)
	this.media_components_in_data = [];

	// section elements. Left list of available section components to export
	this.section_elements = []
	this.section_elements_components_exclude = ['component_password']

	// export runtime. THE LIFETIME of everything the current export view keeps
	// open (see reset_export_runtime): job streams hold an HTTP connection each
	// (job_follow.js), so they must be released, not merely muted.
	this.job_followers	= create_job_follower_group()
	this.export_timers	= new Set()
	this.export_raf		= null
	this.export_abort	= new AbortController()
	// settle callbacks of file builds still waiting on their job: a reset
	// cancels their follow (no on_done), so it must settle them itself
	this.export_pending	= new Set()
	// the current export (set by render_tool_export: run / reconnect)
	this.export_state	= null
}//end tool_export



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	tool_export.prototype.render						= tool_common.prototype.render
	tool_export.prototype.refresh						= common.prototype.refresh
	tool_export.prototype.edit							= render_tool_export.prototype.edit
	tool_export.prototype.build_export_component		= render_tool_export.prototype.build_export_component
	tool_export.prototype.component_has_parent_targets	= render_tool_export.prototype.component_has_parent_targets
	tool_export.prototype.update_parents_checks_state	= render_tool_export.prototype.update_parents_checks_state
	tool_export.prototype.update_lang_state			= render_tool_export.prototype.update_lang_state
	tool_export.prototype.sync_ar_ddo_to_export			= render_tool_export.prototype.sync_ar_ddo_to_export
	// server round-trip helper (components_with_parent action — WC-049)
	tool_export.prototype.tool_request					= tool_common.prototype.tool_request
	// get and render list of components from common
	tool_export.prototype.get_section_elements_context	= common.prototype.get_section_elements_context
	tool_export.prototype.calculate_component_path		= common.prototype.calculate_component_path
	// drag
	tool_export.prototype.on_dragstart					= on_dragstart
	tool_export.prototype.on_dragover					= on_dragover
	tool_export.prototype.on_dragleave					= on_dragleave
	tool_export.prototype.on_drop						= on_drop
	tool_export.prototype.on_dragend					= on_dragend
	tool_export.prototype.set_sort_payload				= set_sort_payload
	// phone gestures (touch twins of the two drags): add via a tap "+", reorder
	// via up/down buttons. See phone_tool_export.js
	tool_export.prototype.on_component_row				= on_component_row
	tool_export.prototype.add_export_component_from_row	= add_export_component_from_row
	tool_export.prototype.move_export_component			= move_export_component
	tool_export.prototype.update_phone_reorder_state	= update_phone_reorder_state



/**
* INIT
* Runs once after the tool is instantiated.  Delegates generic tool
* initialisation to `tool_common.prototype.init`, then seeds the
* tool-export-specific instance vars that are not covered by `tool_common`.
*
* Side effects:
* - Calls `self.caller.build(true)` to ensure the caller section's RQO/SQO
*   are populated before being read (`self.source`, `self.sqo`).
* - Sets `self.lang` from `options.lang` (the active data language, e.g.
*   "lg-eng"), and `self.langs` from `page_globals.dedalo_projects_default_langs`.
* - Resets transient state: `events_tokens`, `components_list`, `ar_instances`,
*   `ar_ddo_to_export`, and initial pagination sentinels.
*
* @param {Object} options - Options object from the tool launcher.
*   Sample:
*   {
*     lang: "lg-eng",
*     mode: "edit",
*     model: "tool_export",
*     section_id: "1",
*     section_tipo: "rsc167",
*     tipo: "rsc36",
*     tool_config: { section_id: "2", section_tipo: "dd1324", name: "tool_export",
*                    label: "Tool Indexation", icon: "/v6/tools/tool_export/img/icon.svg", … }
*   }
* @returns {Promise<boolean>} Resolves to the value returned by `tool_common.prototype.init`
*   (true on success, false if the generic init failed).
*/
tool_export.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
	const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// build the section that call, it's necessary to build the rqo
			if (!self.caller || typeof self.caller.build!=='function') {
				throw new Error("Caller build is not available.");
			}
			await self.caller.build(true)

		// set the self specific vars not defined by the generic init (in tool_common)
			self.lang	= options.lang // from page_globals.dedalo_data_lang
			self.langs	= page_globals.dedalo_projects_default_langs

		// short vars
			self.events_tokens			= []
			self.parent_node			= null
			self.components_list		= {}
			self.ar_instances			= []
			self.source					= self.caller.rqo.source
			self.sqo					= self.caller.rqo.sqo
			self.target_section_tipo	= self.sqo.section_tipo // can be different to section_tipo
			self.limit					= self.sqo.limit ?? 10
			self.ar_ddo_to_export		= []
	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* Fetches the available section components that can be offered as export columns
* (the left-panel "components list" in the UI).
*
* Delegates to `tool_common.prototype.build` for generic scaffolding, then
* calls `get_section_elements_context` (from `common.prototype`) to fetch the
* ontology-driven component list for `target_section_tipo`, excluding
* `section_elements_components_exclude` (e.g. `component_password`).
*
* The result is stored in `self.section_elements` and consumed by
* `render_tool_export.prototype.edit` when building the left panel.
*
* @param {boolean} [autoload=false] - Passed through to `tool_common.prototype.build`;
*   when true the build was triggered automatically (e.g. on init) rather than
*   by explicit user action.
* @returns {Promise<boolean>} The value returned by `tool_common.prototype.build`.
*/
tool_export.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// components_list. Prepare section component list [left] for render
		self.section_elements = await self.get_section_elements_context({
			section_tipo			: self.target_section_tipo,
			ar_components_exclude	: self.section_elements_components_exclude
		})

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build



/**
* GET_SECTION_ID
* Generates an incrementing unique ID string for temporary export section nodes.
*
* (!) Note: this mutates `self.section_id` in place by pre-incrementing it,
* which means `section_id` drifts from any numeric ID set by the server during
* the session. Only use this for transient DOM node IDs, never as a persistent
* record identifier.
*
* @returns {string} A unique string of the form 'tmp_export_N', where N starts
*   at the value of `self.section_id + 1` and increments on each call.
*/
tool_export.prototype.get_section_id = function() {

	const self		= this
	self.section_id	= ++self.section_id

	return 'tmp_export_' + self.section_id
}//end get_section_id



/**
* THE SERVER-BUILT EXPORT — client half (tool_export at scale)
*
* The browser no longer receives the export. `build_export_artifact` runs as a
* background job on the 'export' lane and writes every line of the export into
* a SPOOL on the server; the preview reads ONE page of it
* (`get_export_preview`), and every download is a file the server builds from
* the whole spool (`build_export_file`, a background job on its own
* 'export_file' lane, never queued behind a walk) and serves from
* an owner-only GET route. Browser memory therefore does not depend on the
* number of exported records.
*
* Wire (dd_tools_api::tool_request, source.action = the tool action;
* server: tools/tool_export/server/{index,export_job,preview}.ts):
*   build_export_artifact {section_tipo, model, data_format, breakdown,
*       fill_the_gaps, ar_ddo_to_export, sqo, background_running:true}
*       → ok(true) + extension keys {job_id (lane job), pfile, pid}.
*       Frames (dd_utils_api::get_job_events): data = {msg, job_id (ARTIFACT
*       id), written, total, is_running}; the terminal frame's data is the
*       handler's envelope {ok, data:{job_id, status:'ended', total, records,
*       rows, …}}, or errors:[…] on a failure / stop.
*   get_export_preview {section_tipo, job_id, page, page_size}
*       → {job_id, status, cols, final_order, rows, page, page_size,
*          first_record, records, has_more, total_records, written_records,
*          media_models (what the media ZIP can archive — the media button
*          and its quality modal read it, never the column models)}
*   build_export_file {section_tipo, job_id, format, origin,
*       show_tipo_in_label, media_qualities?, background_running:true}
*       → lane job; terminal data = {ok, data:{job_id, format, basename, url,
*         bytes, rows}}
*   list_export_jobs {section_tipo} → {jobs:[{job_id, status, total, records,
*       rows, data_format, breakdown, files,
*       error:{code, label_key, message, retryable, details?}|null — only
*       {code} for a code the registry no longer knows, …}],
*       pending:[{background_job_id, submitted_at}]}
*       newest first; `pending` = submitted walks with no manifest yet
*       (queued in the lane) — reconnect follows the newest one
*   delete_export_job {section_tipo, job_id} → {job_id, deleted:true,
*       freed_bytes} — owner-only; refused with export.artifact_busy (409)
*       while the export runs or a file is being built from it (Stop first)
*   get_background_jobs {action} (framework) → [{id, action, status, …}]
*   dd_utils_api::stop_process {pfile} — stops a lane job.
*
* Errors ride the envelope v2 contract: a refused call resolves with
* `error` (an ApiError — request_failed / error_text), which data_manager has
* already published to the page policy. Submissions are sent with retries:0 so
* a retryable refusal (export.too_many_jobs, 429) reaches the user at once
* instead of being retried silently behind a spinner.
*/



/**
* EXPORT_RQO
* The dd_tools_api::tool_request body of one tool_export action.
* @param {Object} self - tool_export instance
* @param {string} action - tool action name
* @param {Object} options - action options
* @returns {Object} rqo
*/
const export_rqo = function(self, action, options) {

	return {
		dd_api			: 'dd_tools_api',
		action			: 'tool_request',
		prevent_lock	: true,
		source			: create_source(self, action),
		options			: options
	}
}//end export_rqo



/**
* EXPORT_READ
* A READ of the export (preview page, job list, lane jobs): retried by the
* transport (retries:2) — a resent read changes nothing.
* @param {Object} self - tool_export instance
* @param {string} action - tool action name
* @param {Object} options - action options
* @param {AbortSignal|null} [signal]
* @returns {Promise<Object>} the API envelope (test with request_failed)
*/
const export_read = function(self, action, options, signal=null) {

	return data_manager.request({
		body	: export_rqo(self, action, options),
		signal	: signal || null,
		retries	: 2,
		timeout	: 30000
	})
}//end export_read



/**
* EXPORT_SUBMIT
* A BACKGROUND submission (build_export_artifact / build_export_file). Never
* retried (retries:0): a retryable refusal (export.too_many_jobs, 429) must
* reach the user, and a resend could queue a second job.
* @param {Object} self - tool_export instance
* @param {string} action - tool action name
* @param {Object} options - action options
* @returns {Promise<Object>} the API envelope; extension keys job_id / pfile
*/
const export_submit = function(self, action, options) {

	return data_manager.request({
		body	: export_rqo(self, action, {...options, background_running: true}),
		retries	: 0,
		timeout	: 30000
	})
}//end export_submit



/**
* EXPORT_COMMAND
* A foreground command that changes the caller's exports (delete_export_job).
* Sent once (retries:0): the user sees the answer, and a lost answer is
* settled by re-reading the job list, never by resending.
* @param {Object} self - tool_export instance
* @param {string} action - tool action name
* @param {Object} options - action options
* @returns {Promise<Object>} the API envelope
*/
const export_command = function(self, action, options) {

	return data_manager.request({
		body	: export_rqo(self, action, options),
		retries	: 0,
		timeout	: 30000
	})
}//end export_command



/**
* START_EXPORT_JOB
* Submit build_export_artifact as a background job with the tool's current
* export options (the same options the old NDJSON stream sent).
* @param {Object} options - {data_format, breakdown, ar_ddo_to_export, fill_the_gaps}
*   or {rerun_of} (an artifact id: run that recorded export again)
* @returns {Promise<Object>} envelope; on success the extension keys `job_id`
*   (lane job, followable) and `pfile` (stop_process handle)
*/
tool_export.prototype.start_export_job = function(options) {

	const self = this

	// sqo. The caller's filter, cloned. No limit/offset override: the export
	// grid forces the internal 'ALL' sentinel server-side (grid.ts, after
	// sanitizeClientSqo), so the export always covers the whole filtered selection.
	const sqo = clone(self.sqo)

	// A RE-RUN (options.rerun_of = the artifact id): the server runs the
	// RECORDED options of that export again — only the gated section travels.
	if (options.rerun_of) {
		return export_submit(self, 'build_export_artifact', {
			section_tipo	: self.caller.section_tipo,
			rerun_of		: options.rerun_of
		})
	}

	return export_submit(self, 'build_export_artifact', {
		section_tipo		: self.caller.section_tipo,
		model				: self.caller.model,
		data_format			: options.data_format,
		breakdown			: options.breakdown || 'default',
		lang				: options.lang,
		fill_the_gaps		: options.fill_the_gaps,
		ar_ddo_to_export	: options.ar_ddo_to_export,
		sqo					: sqo
	})
}//end start_export_job



/**
* GET_EXPORT_PREVIEW
* One page of an export (records, never split).
* @param {Object} options - {job_id, page, page_size?, col_page?, signal?}
* @returns {Promise<Object>} envelope; data = the preview page (one column
*   window: cols, col_page, col_page_size, first_col, total_cols, col_models,
*   media_models — the media the media ZIP can archive, at any path depth)
*/
tool_export.prototype.get_export_preview = function(options) {

	const self = this

	const fn_options = {
		section_tipo	: self.caller.section_tipo,
		job_id			: options.job_id,
		page			: options.page || 0,
		col_page		: options.col_page || 0
	}
	if (options.page_size) {
		fn_options.page_size = options.page_size
	}

	return export_read(self, 'get_export_preview', fn_options, options.signal)
}//end get_export_preview



/**
* LIST_EXPORT_JOBS
* The caller's exports of this section, newest first (the reconnect wire).
* @param {Object} [options] - {signal?}
* @returns {Promise<Object>} envelope; data = {jobs:[…]}, each job's `error`
*   = {code, label_key, message, retryable, details?} | null (only {code} for a
*   code the registry no longer knows)
*/
tool_export.prototype.list_export_jobs = function(options={}) {

	const self = this

	return export_read(self, 'list_export_jobs', {
		section_tipo : self.caller.section_tipo
	}, options.signal)
}//end list_export_jobs



/**
* DELETE_EXPORT_JOB
* Delete one of the caller's exports of this section with all its files (the
* spool and every built download), freeing its bytes of the user's quota. The
* server refuses a running export or one a file is being built from
* (export.artifact_busy): stop it first.
* @param {string} job_id - the artifact id
* @returns {Promise<Object>} envelope; data = {job_id, deleted, freed_bytes}
*/
tool_export.prototype.delete_export_job = function(job_id) {

	const self = this

	return export_command(self, 'delete_export_job', {
		section_tipo	: self.caller.section_tipo,
		job_id			: job_id
	})
}//end delete_export_job



/**
* GET_BACKGROUND_JOBS
* The caller's lane jobs of this tool (framework action), newest first — how a
* reopened tool finds the lane job (follow + stop handle) of a running export.
* @param {string} action - e.g. 'build_export_artifact'
* @param {Object} [options] - {signal?}
* @returns {Promise<Object>} envelope; data = [{id, action, status, started_at, …}]
*/
tool_export.prototype.get_background_jobs = function(action, options={}) {

	const self = this

	return export_read(self, 'get_background_jobs', {action: action}, options.signal)
}//end get_background_jobs



/**
* START_EXPORT_FILE
* Submit build_export_file (background): one downloadable file of an ENDED
* export. `origin` lets the server write the same absolute media links the
* browser would have.
* @param {Object} options - {job_id, format, show_tipo_in_label, media_qualities?}
* @returns {Promise<Object>} envelope; extension keys job_id / pfile as above
*/
tool_export.prototype.start_export_file = function(options) {

	const self = this

	const fn_options = {
		section_tipo		: self.caller.section_tipo,
		job_id				: options.job_id,
		format				: options.format,
		origin				: window.location.origin,
		show_tipo_in_label	: options.show_tipo_in_label===true
	}
	if (options.media_qualities && typeof options.media_qualities==='object') {
		fn_options.media_qualities = options.media_qualities
	}

	return export_submit(self, 'build_export_file', fn_options)
}//end start_export_file



/**
* STOP_EXPORT_PROCESS
* Stop a lane job (the export or a file build) by its pfile handle. The server
* aborts the job at its next batch boundary and deletes the partial spool.
* @param {string} pfile - '<lane job id>.json'
* @returns {Promise<Object>} envelope
*/
tool_export.prototype.stop_export_process = function(pfile) {

	return data_manager.request({
		body : {
			dd_api	: 'dd_utils_api',
			action	: 'stop_process',
			options	: {
				pfile : pfile
			}
		},
		retries : 0
	})
}//end stop_export_process



/**
* RESET_EXPORT_RUNTIME
* Release EVERYTHING the current export view holds open: every job stream
* (the connection, not just the callback — job_follow.js) and whatever waits
* on one (pending file builds are settled as abandoned), the preview timer,
* the pending rAF of the progress bar, and every in-flight preview / list
* request (their shared AbortController). Called on destroy and on every new
* Export click. It never stops a server job (stop_export_process does that).
* @returns {AbortSignal} a fresh signal for the next run's requests
*/
tool_export.prototype.reset_export_runtime = function() {

	const self = this

	if (self.job_followers) {
		self.job_followers.cancel_all()
	}
	// a cancelled follow never reports its end: release what waits on it (the
	// download button's busy state, the media modal's awaited promise)
	if (self.export_pending) {
		const pending = [...self.export_pending]
		self.export_pending.clear()
		for (const settle of pending) {
			settle()
		}
	}
	if (self.export_timers) {
		for (const timer of self.export_timers) {
			clearTimeout(timer)
		}
		self.export_timers.clear()
	}
	if (self.export_raf) {
		cancelAnimationFrame(self.export_raf)
		self.export_raf = null
	}
	if (self.export_abort) {
		self.export_abort.abort()
	}
	self.export_abort = new AbortController()

	return self.export_abort.signal
}//end reset_export_runtime



/**
* DESTROY
* On an instance destroy (delete_self) release the export runtime (streams,
* timers, requests), then the generic common destroy. The server-side job keeps running: reopening the tool
* reconnects to it (list_export_jobs).
* @param {boolean} [delete_self=true]
* @param {boolean} [delete_dependencies=false]
* @param {boolean} [remove_dom=false]
* @returns {Promise<Object>}
*/
tool_export.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	// Only a destroy of the INSTANCE releases the runtime. A refresh destroys
	// with delete_self=false and re-renders: the current export must keep being
	// followed, and the new DOM repaints it (get_content_data_edit).
	if (delete_self===true) {
		self.reset_export_runtime()
		// no request may start after the tool is gone
		self.export_abort.abort()
		self.export_state = null
	}

	return common.prototype.destroy.call(this, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* ON_CLOSE_ACTIONS
* Hook called by the tool framework immediately before the tool panel closes.
*
* When `open_as` is `'modal'`, destroys the tool instance (removes its DOM
* node and frees event listeners) so that re-opening the modal creates a
* fresh instance rather than reusing stale state.
*
* (!) Refreshing the caller (`self.caller.refresh()`) is intentionally
* suppressed — the caller is `component_json`, which must not be rebuilt just
* because the export modal closed.
*
* @param {string} open_as - How the tool was opened: `'modal'` | `'window'`.
* @returns {Promise<boolean>} Always resolves `true`.
*/
tool_export.prototype.on_close_actions = async function(open_as) {

	const self = this

	if (open_as==='modal') {
		// self.caller.refresh() // never refresh caller (component_json)
		self.destroy(true, true, true)
	}

	return true
}//end on_close_actions



/**
* UPDATE_LOCAL_DB_DATA
* Persists the current `ar_ddo_to_export` column selection to IndexedDB so
* it can be restored the next time the user opens the export tool for the
* same section.
*
* Storage key: `'tool_export_config'` in the `'data'` IndexedDB table.
* Value shape: `{ [target_section_tipo]: ar_ddo_to_export, … }` — a single
* object that holds configurations for ALL sections the user has ever exported,
* keyed by `target_section_tipo`.  Only the entry for the current section is
* updated; other sections' configs are preserved.
*
* When `target_section_tipo` is an Array (multiple-section export), only the
* first element is used as the key to avoid object-key collisions.
*
* The commented-out block at the bottom of this method is dead code from an
* earlier design that pushed individual DDO objects rather than replacing the
* whole array; it is intentionally left in place for reference.
*
* @returns {Promise<boolean>} Resolves `true` after the IndexedDB write completes.
*/
tool_export.prototype.update_local_db_data = async function() {

	const self = this

	// target_section_tipo. Used to create a object property key different for each section
	const target_section_tipo = Array.isArray(self.target_section_tipo)
		? self.target_section_tipo[0]
		: self.target_section_tipo

	// get_local_db_data
	const id		= 'tool_export_config'
	const response	= await data_manager.get_local_db_data(
		id,
		'data'
	)

	// tool_export_config. Current section tool_export_config (fallback to basic object)
	const tool_export_config = response && response.value
		? response.value
		: {
			[target_section_tipo] : []
		  }

	// update current key only and save whole object
		tool_export_config[target_section_tipo] = self.ar_ddo_to_export

	// save
		const cache_data = {
			id		: 'tool_export_config',
			value	: tool_export_config
		}
		await data_manager.set_local_db_data(
			cache_data,
			'data'
		)

	// check if already exists current target section_tipo config ddo
		// const found = tool_export_config[target_section_tipo]
		// 	? tool_export_config[target_section_tipo].find(el => el.id===ddo.id)
		// 	: undefined

	// if not exists current ddo (as expected), add it to local database using current target section_tipo as key
		// if (!found) {
		// 	tool_export_config[target_section_tipo] = tool_export_config[target_section_tipo] || []
		// 	tool_export_config[target_section_tipo].push(ddo)
		// 	// save
		// 	const cache_data = {
		// 		id		: 'tool_export_config',
		// 		value	: tool_export_config
		// 	}
		// 	data_manager.set_local_db_data(
		// 		cache_data,
		// 		'data'
		// 	)
		// }

	return true
}//end update_local_db_data



/**
* COMPOSE_ID
* Builds the stable string ID used to identify a DDO column node in the
* drag-and-drop UI and to key duplicate detection.
*
* Format: `<section_tipo>_<component_tipo>_…_list_<lang>`
* Example: `rsc167_rsc10_list_lg-eng`
*
* The ID encodes the full traversal path (each path step contributes one
* `section_tipo_component_tipo` segment) followed by the `lang` qualifier of
* the DDO. This makes IDs unique across nested relation traversals that would
* otherwise share the same leaf component_tipo.
*
* @param {Object} ddo  - The DDO (data-description object) for the export column;
*   must have a `lang` property (e.g. `"lg-eng"`).
* @param {Array}  path - The ordered traversal path from the top section to
*   this component; each element must have `section_tipo` and `component_tipo`.
* @returns {string} The composed column ID string.
*/
tool_export.prototype.compose_id = function (ddo, path) {

	const id = path.map(el => el.section_tipo +'_'+ el.component_tipo).join('_') +'_list_'+ ddo.lang

	return id
}//end compose_id



// @license-end
