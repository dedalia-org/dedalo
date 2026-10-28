// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_DIFFUSION_API_URL */
/*eslint no-undef: "error"*/



/**
* TOOL_DIFFUSION module
*
* Client-side controller for the Dédalo diffusion tool. Diffusion is the process
* of publishing records from the Dédalo work database to external SQL/RDF/XML targets
* via the Bun middleware (see diffusion/api/v1/index.ts and class.dd_diffusion_api.php).
*
* Architecture overview
* ---------------------
* - This file defines the `tool_diffusion` constructor and all prototype methods that
*   communicate with the diffusion API. UI rendering lives in render_tool_diffusion.js.
* - All API calls are routed through `DEDALO_DIFFUSION_API_URL` when defined; otherwise
*   they fall back to the generic `data_manager.url`. The Bun server owns the diffusion
*   socket and is the sole entry point for MariaDB writes — PHP never connects directly.
* - The `diffuse` action triggers an SSE stream (via `data_manager.request_stream`) so
*   the browser can display per-record progress in real time.
*
* Key instance properties (set by build())
* -----------------------------------------
* - diffusion_info  {Object}  - Server-side config: section_diffusion_nodes[], resolve_levels, skip_publication_state_check.
* - bun_status      {Object}  - Bun engine health: { ready: bool, label: string, checks }.
* - active_processes {Array}  - List of running or recently finished diffusion processes.
* - resolve_levels  {number}  - Resolved from diffusion_info; defaults to 1.
* - skip_publication_state_check {number} - Whether to bypass the publication-state guard; from diffusion_info.
* - additions_options {Object} - Per-instance custom options (e.g. XML group files).
*
* Exports: tool_diffusion (constructor)
*/

// import needed modules
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_diffusion} from './render_tool_diffusion.js' // self tool rendered (called from render common)
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	// THE accessor for a successful call's payload (envelope v2 `data`, compat
	// `result`). Every read below goes through it — never `response.result`.
	import {response_data} from '../../../core/common/js/api_error.js'



/**
* TOOL_DIFFUSION
* Constructor for the tool_diffusion instance.
*
* Extends tool_common via prototype assignment. All shared tool lifecycle methods
* (render, destroy, refresh) are inherited; the diffusion-specific init/build
* methods customise the sequence to prefetch API status before rendering.
*
* Instances are created and managed by the tool framework (tool_common + common).
* The `caller` property references the section or component that launched the tool,
* providing the active section_tipo and section_id used in every API call.
*/
export const tool_diffusion = function () {

	// lifecycle / identity (set by tool_common.prototype.init)
	this.id				= null
	this.model			= null
	this.mode			= null
	this.node			= null
	this.ar_instances	= null
	this.events_tokens	= null
	this.status			= null
	this.main_element	= null
	this.type			= null
	this.source_lang	= null
	this.target_lang	= null
	this.langs			= null

	// the section or component that opened the tool; provides section_tipo / section_id
	this.caller			= null

	// diffusion-specific state (populated in build())
	this.diffusion_info = null
	this.bun_status     = null
	// (!) skip_publication_state_check is declared without initialisation here;
	// it is set in build() from diffusion_info. Accessing it before build() returns undefined.
	this.skip_publication_state_check

	// optional options. Custom options like XML group files
	this.additions_options = {
		info : 'Custom diffusion class options'
	}


	return true
}//end page



/**
* COMMON FUNCTIONS
* Prototype assignments that wire tool_diffusion into the shared tool and component
* lifecycle. These must appear before any prototype method definitions so that
* inherited methods are available during init/build.
*
* render  — delegates to tool_common, which dispatches to the .edit view.
* destroy — standard common teardown (removes DOM node, clears event tokens).
* refresh — standard common refresh (calls destroy + re-init/build).
* edit    — DOM builder from render_tool_diffusion; called by tool_common.render
*           when mode === 'edit' (the only mode this tool exposes).
*/
// prototypes assign
	tool_diffusion.prototype.render		= tool_common.prototype.render
	tool_diffusion.prototype.destroy	= common.prototype.destroy
	tool_diffusion.prototype.refresh	= common.prototype.refresh
	// render mode edit (default). Set the tool custom manager to build the DOM nodes view
	tool_diffusion.prototype.edit		= render_tool_diffusion.prototype.edit



/**
* INIT
* Custom tool init.
*
* Delegates immediately to tool_common.prototype.init, which validates options,
* sets instance identity properties (id, model, mode, caller, lang, status, etc.)
* and registers the instance in the global instance map.
*
* The comment block below the common_init call is a placeholder for any future
* tool-specific initialisation that must run AFTER the generic init completes
* but BEFORE build() is called (e.g. reading tool_config overrides).
*
* @param {Object} options - Standard tool init options forwarded to tool_common.
* @returns {Promise<boolean>} Resolves with the result of tool_common.prototype.init.
*/
tool_diffusion.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	// set the self specific vars not defined by the generic init (in tool_common)


	return common_init
}//end init



/**
* BUILD
* Custom tool build.
*
* Calls tool_common.prototype.build first (which triggers render/edit), then fires
* three parallel API requests to populate the diffusion-specific instance state that
* render_tool_diffusion.js reads when building the UI:
*
*   diffusion_info    — ontology nodes available for the caller's section_tipo plus
*                       the server-configured resolve_levels and skip_publication_state_check.
*   bun_status        — live Bun engine health check (is the middleware reachable?).
*   active_processes  — list of currently running or recently finished diffusion runs.
*
* Errors from any of the three requests are caught and stored on self.error so the
* render layer can surface them without a fatal throw.
*
* @param {boolean} [autoload=false] - Forwarded to tool_common.prototype.build.
* @returns {Promise<boolean>} Resolves with the result of tool_common.prototype.build.
*/
tool_diffusion.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// engine advisory gate (auto-recovers for admins; clean JSON even when engine down)
			const advisory = await self.get_engine_advisory({})
			self.engine_advisory = advisory
			// client-built badge state (never a wire shape): is the engine usable,
			// and the one line to print beside it
			self.bun_status = {
				ready  : advisory.state === 'ok',
				label  : advisory.state === 'ok' ? 'Ready' : (advisory.title || 'Unavailable'),
				checks : advisory.checks || null
			}

		if (advisory.state === 'ok') {
			// engine healthy: load the diffusion body as before
			;[self.diffusion_info, self.active_processes] = await Promise.all([
				self.get_diffusion_info(),
				self.get_active_processes(),
			])
			// (!) data_manager.request NEVER rejects: on a network/HTTP failure it
			// returns {result:false, msg} and records the failure in
			// page_globals.api_errors. Without this guard diffusion_info would be
			// `false`, the `?? 1` reads below would silently succeed (property access
			// on a boolean), self.error would stay unset — and render() would fall
			// through to common.prototype.render, whose api_errors short-circuit
			// returns a generic error node with no .tool_header. The caller then
			// throws the useless 'Invalid tool wrapper: missing tool_header',
			// masking the real cause. Fail loudly here instead.
			if (!self.diffusion_info) {
				throw new Error('Unable to load the diffusion configuration from the server. See the browser console / server log for the failing request.')
			}
			self.resolve_levels               = self.diffusion_info.resolve_levels ?? 1
			self.skip_publication_state_check = self.diffusion_info.skip_publication_state_check ?? 1
		} else {
			// engine down/unhealthy: render() will show the advisory banner and skip the body
			self.diffusion_info  = self.diffusion_info  || {}
			self.active_processes = self.active_processes || []
		}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom



/**
* GET_DIFFUSION_INFO
* Fetches the server-side diffusion configuration for the caller's section_tipo.
*
* The PHP handler (dd_diffusion_api::get_diffusion_info) returns:
*   {
*     result                       : false | { section_diffusion_nodes: Array, resolve_levels: number,
*                                              skip_publication_state_check: number }
*   }
*
* `section_diffusion_nodes` lists the ontology nodes (diffusion_tipo values) that the
* section can be diffused to, along with their labels and output types. These are used
* by render_tool_diffusion to build the diffusion-target picker UI.
*
* The resolved value is stored on `self.diffusion_info` in build(); render_tool_diffusion
* reads `self.diffusion_info` directly.
*
* @returns {Promise<Object>} Resolves with the response PAYLOAD (envelope v2 `data`;
*   undefined on failure, which build() turns into a loud throw).
*/
tool_diffusion.prototype.get_diffusion_info = function() {

	const self = this

	// short vars
		const section		= self.caller
		const section_tipo	= section.section_tipo

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'get_diffusion_info')

	// rqo
		const rqo = {
			dd_api	: 'dd_diffusion_api',
			action	: 'get_diffusion_info',
			source	: source,
			options : {
				section_tipo : section_tipo
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				url	: typeof DEDALO_DIFFUSION_API_URL !== 'undefined' ? DEDALO_DIFFUSION_API_URL : data_manager.url,
				body : rqo
			})
			.then(function(response){
				if(SHOW_DEBUG===true) {
					console.log('-> get_diffusion_info API response:', response);
				}

				// Envelope v2: the payload lives in `data` (the compat `result`
				// mirror is read by the same accessor, and dies with it).
				const result = response_data(response)

				resolve(result)
			})
		})
}//end get_diffusion_info



/**
* EXPORT
* Triggers the diffuse action on the Bun/PHP API and returns a ReadableStream for
* real-time progress tracking.
*
* "Export" in the diffusion context means "publish work data to an external target"
* (SQL table, RDF file, XML file). The name `export` is used for historical reasons;
* see dd_diffusion_api::diffuse() on the PHP side.
*
* SQO (Search Query Object) construction
* ---------------------------------------
* The SQO sent to the server defines the record set to diffuse:
*   - In `edit` mode (single-record view), it is always a one-record filter using the
*     caller's section_id. `total` is forced to 1.
*   - In `list` mode, the caller's existing rqo.sqo is reused (preserving any active
*     search filters and pagination), or a bare section_tipo filter is constructed.
*     `total` is taken from `self.caller.total` for progress-bar display.
*
* The `process_id` option lets Bun's process tracker correlate SSE events back to the
* UI entry shown in the active-processes panel (created by the caller before invoking
* this method).
*
* The stream returned is a raw `ReadableStream` (Fetch API). The caller (render_tool_diffusion)
* pipes it through `render_stream` to decode NDJSON progress events.
*
* @param {Object} options - Diffuse call options.
* @param {Object}  [options.item]                  - Diffusion target descriptor (from section_diffusion_nodes).
* @param {string}  [options.diffusion_element_tipo] - Overrides item.element_tipo when provided.
* @param {string}  [options.diffusion_tipo]         - Overrides item.diffusion_tipo when provided.
* @param {number}  [options.resolve_levels]         - Overrides self.resolve_levels.
* @param {string}  [options.process_id]             - Bun process tracking ID.
* @param {string}  [options.type]                   - Diffusion output type (e.g. 'sql', 'rdf', 'xml').
* @returns {Promise<ReadableStream>} Resolves with the raw SSE ReadableStream from Bun.
*/
tool_diffusion.prototype.export = function(options) {

	const self = this

	// options
		const item 						= options.item || null
		const resolve_levels			= options.resolve_levels || self.resolve_levels

	// sort vars
		const diffusion_element_tipo		= options.diffusion_element_tipo ?? item?.element_tipo
		const diffusion_tipo				= options.diffusion_tipo ?? item?.diffusion_tipo ?? null
		const section_tipo					= self.caller.section_tipo
		const section_id					= self.caller.section_id || null
		const caller_mode					= self.caller.mode
		const total 						= caller_mode === 'edit' ? 1 : (self.caller.total || null)

		// build the SQO based on the caller's current mode:
		// in 'edit' mode, always scope to the single open record; in list mode,
		// reuse the caller's current search query (preserving filters, sort, pagination).
		const sqo = (caller_mode === 'edit')
			? {
				section_tipo 		: [section_tipo],
				filter_by_locators 	: section_id ? [{ section_tipo : section_tipo, section_id : section_id }] : null,
				limit 				: 1
			}
			: (self.caller.rqo.sqo || {
				section_tipo 		: [section_tipo],
				filter_by_locators 	: section_id ? [{ section_tipo : section_tipo, section_id : section_id }] : null
			})
		const skip_publication_state_check	= self.skip_publication_state_check
		const additions_options				= self.additions_options || {}

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'diffuse')

	// rqo: action='diffuse' is routed to dd_diffusion_api::diffuse() via Bun.
	// The `sqo` top-level key (not nested in options) is the standard Dédalo convention
	// for passing search query objects alongside per-call options.
		const rqo = {
			dd_api	: 'dd_diffusion_api',
			action	: 'diffuse',
			source	: source,
			sqo 	: sqo,
			options : {
				levels							: resolve_levels,
				skip_publication_state_check	: skip_publication_state_check,
				additions_options				: additions_options,
				total							: total,
				process_id						: options.process_id,
				diffusion_element_tipo			: diffusion_element_tipo,
				diffusion_tipo					: diffusion_tipo,
				type							: item?.type || options.type
			}
		}

	// call to the API using streaming request.
	// request_stream sets body.is_stream=true and sends Accept: text/event-stream.
	// The resolved ReadableStream is consumed by render_stream in the render layer.
		return new Promise(function(resolve){
			data_manager.request_stream({
				url		: typeof DEDALO_DIFFUSION_API_URL !== 'undefined' ? DEDALO_DIFFUSION_API_URL : data_manager.url,
				body	: rqo
			})
			.then(function(stream){
				resolve(stream)
			})
			.catch(function(api_error){
				// request_stream REJECTS with an ApiError (its @throws) when the run
				// never opens — a dead socket, or the session that expired between
				// loading the panel and pressing Publish. Without this handler that
				// rejection was unhandled AND the promise never settled, so the caller
				// awaited a stream that could not arrive and the button stayed
				// 'loading' for the rest of the session. Route it (auth.not_logged
				// reaches the relogin overlay) and resolve NULL so the caller unlocks.
				handle_api_error(api_error, {scope:'tool_diffusion'})
					.catch(function(dispatch_error){
						console.error('[tool_diffusion] error dispatch failed:', dispatch_error)
					})
				resolve(null)
			})
		})
}//end export



/**
* GET_ACTIVE_PROCESSES
* Fetches the list of currently running and recently finished diffusion processes
* from the Bun server's in-memory process registry.
*
* Maps to the Bun-only `list_processes` action (index.ts `get_all_processes()`).
* PHP is not involved. The Bun server returns:
*   { result: true, processes: ProcessLog[] }
*
* Each ProcessLog entry typically carries: { id, section_tipo, diffusion_tipo,
* status ('running'|'finished'|'cancelled'), started_at, finished_at, error? }.
*
* On network error resolves with [] so the render layer can always safely iterate
* `self.active_processes`.
*
* @returns {Promise<Array>} Resolves with the processes array, or [] on failure.
*/
tool_diffusion.prototype.get_active_processes = function() {

	const self = this
	const source = create_source(self, 'get_active_processes')

	const rqo = {
		dd_api	: 'dd_diffusion_api',
		action	: 'list_processes',
		source	: source
	}

	return new Promise(function(resolve){
		data_manager.request({
			url		: typeof DEDALO_DIFFUSION_API_URL !== 'undefined' ? DEDALO_DIFFUSION_API_URL : data_manager.url,
			body	: rqo
		})
		.then(function(response){
			if(SHOW_DEBUG===true) {
				console.log('-> get_active_processes API response:', response);
			}
			resolve(response.processes || [])
		})
		.catch(function(err){
			console.error('get_active_processes error:', err)
			resolve([])
		})
	})
}//end get_active_processes



/**
* ON_CLOSE_ACTIONS
* Hook called by the tool framework immediately before the tool window or modal
* is closed. Runs tool-specific teardown logic based on how the tool was opened.
*
* - modal: destroys the instance (removes DOM, clears event tokens).
*   The commented-out `self.caller.refresh()` is intentionally suppressed: the caller
*   is typically a component_json/section and must NOT be refreshed on tool close,
*   as that would discard unsaved caller state.
* - window (popup): no action needed; the window OS-level close handles teardown.
*
* @param {string} open_as - How the tool was opened: 'modal' | 'window'.
* @returns {Promise<boolean>} Always resolves true.
*/
tool_diffusion.prototype.on_close_actions = async function(open_as) {

	const self = this

	if (open_as==='modal') {
		// self.caller.refresh() // never refresh caller (component_json)
		self.destroy(true, true, true)
	}

	return true
}//end on_close_actions



/**
* UNREACHABLE_ADVISORY
* The client-side stand-in for an advisory we could not fetch. Same SHAPE the
* server emits (state/is_admin/title/cause/steps/actions/checks) so the banner
* renderer needs no second branch — and, like the server's, it carries no
* `result` key: `state` is the whole verdict.
* @return object
*/
const unreachable_advisory = () => ({
	state		: 'unreachable',
	is_admin	: false,
	title		: 'Diffusion is temporarily unavailable',
	cause		: '',
	steps		: [],
	actions		: ['retry'],
	checks		: null
})



/**
* GET_ENGINE_ADVISORY
* Server-side engine health + role-tailored advisory. Returns clean JSON, never
* a 404.
*
* (!) No `auto_recover` option any more (WC-076). It asked the server to restart
* a separate diffusion DAEMON before answering. Post-cutover the engine runs
* INSIDE the server process — there is nothing to recover, and the request that
* would have asked for it is being served by the very thing it would restart.
*
* @return promise<object> advisory
*/
tool_diffusion.prototype.get_engine_advisory = function() {

	const self = this

	const source = create_source(self, 'get_engine_advisory')

	const rqo = {
		dd_api	: 'dd_diffusion_api',
		action	: 'get_engine_advisory',
		source	: source,
		options : {}
	}

	return new Promise(function(resolve){
		data_manager.request({
			url		: data_manager.url,
			body	: rqo
		})
		.then(function(response){
			if(SHOW_DEBUG===true) {
				console.log('-> get_engine_advisory response:', response);
			}
			// Envelope v2: the advisory is PAYLOAD (`data`), not a set of
			// top-level body keys, and it carries NO `result` — `state` IS the
			// verdict (src/diffusion/api/info.ts buildEngineAdvisory). A failed
			// call has no payload at all, so it degrades to the same unreachable
			// advisory the transport catch below returns.
			resolve(response_data(response) || unreachable_advisory())
		})
		.catch(function(err){
			console.error('get_engine_advisory error:', err)
			resolve(unreachable_advisory())
		})
	})
}//end get_engine_advisory



/**
* RETRY_PENDING_DELETIONS
* Retries delete-propagation rows that could not reach their diffusion target when a
* record was deleted from the work database (a target down at delete time logs the
* failure to dd1758 as action='unpublish_pending').
*
* With `options.count_only` it asks the read-only `count_pending_deletions` action
* instead (the badge, on tool open and after each retry): nothing is retried.
* Both answer `{summary, total, retried, remaining}`.
*
* On network failure resolves with `{ result: false, msg: <error message> }` so the
* render layer always receives a safe response object.
*
* @param {Object} [options={}]            - Call options.
* @param {boolean} [options.count_only]   - If true, only return the pending count; do not retry.
* @param {number}  [options.limit]        - Maximum number of pending rows to retry per call (default 100).
* @returns {Promise<Object>} Resolves with the full API response object.
*/
tool_diffusion.prototype.retry_pending_deletions = function(options={}) {

	const self = this

	const action = options.count_only ? 'count_pending_deletions' : 'retry_pending_deletions'

	// source
		const source = create_source(self, action)

	// rqo
		const rqo = {
			dd_api	: 'dd_diffusion_api',
			action	: action,
			source	: source,
			options : options.count_only ? {} : { limit : options.limit || 100 }
		}

		return new Promise(function(resolve){
			data_manager.request({
				url		: typeof DEDALO_DIFFUSION_API_URL !== 'undefined' ? DEDALO_DIFFUSION_API_URL : data_manager.url,
				body	: rqo
			})
			.then(function(response){
				if(SHOW_DEBUG===true) {
					console.log('-> ' + action + ' API response:', response);
				}
				resolve(response)
			})
			.catch(function(err){
				console.error(action + ' error:', err)
				resolve({ result: false, msg: err.message || 'Bun unreachable' })
			})
		})
}//end retry_pending_deletions



// @license-end
