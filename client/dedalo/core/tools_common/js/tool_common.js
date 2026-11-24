// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global Promise, page_globals, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_TOOLS_URL, DEDALO_CORE_URL, get_label */
/*eslint no-undef: "error"*/



/**
* TOOL_COMMON (module)
* Base constructor, lifecycle methods, and top-level entry points shared by every
* Dédalo tool (tool_export, tool_lang, tool_diffusion, tool_print, etc.).
*
* A Dédalo tool is a specialised UI overlay (modal, standalone window, or tab) that
* operates on one or more components/sections without being part of the normal
* component render tree.  This module provides:
*
*   - `tool_common` — prototype base for every tool; all tools wire in its
*       `init`, `build`, and `render` methods via `wire_tool`.
*   - `wire_tool` — one-shot helper that stamps the common render/destroy/refresh
*       prototypes onto a concrete tool constructor (replaces the boilerplate each
*       tool file used to repeat manually).
*   - `open_tool` — the single public dispatcher that determines how a tool should
*       be visualised (modal, new window, or attached onto its caller) and hands off
*       to `view_modal` / `view_window` / `view_attach`.
*   - `is_tool_attached` — whether an `open_as:'attach'` tool is currently attached
*       to a given caller (read by the component tool button to keep its pressed
*       state across re-renders).
*   - `load_component` — utility to asynchronously instantiate and build a component
*       inside a tool, managing the tool's `ar_instances` registry.
*   - `get_tool_label` — label resolver bound to `this.context.labels`
*       of the tool instance; assigned as `self.get_tool_label` so each tool can
*       call it on its own context.
*
* Lifecycle (for every tool instance):
*   1. `init(options)`  — seeds properties; rebuilds caller from URL `raw_data` when
*        the tool runs in a new window (caller_is_calculated path).
*   2. `build(autoload)` — loads tool CSS; instantiates ddo_map elements; optionally
*        fetches tool context from API (component_json dd1353 / dd1324).
*   3. `render(options)` — delegates to the concrete tool's render, or falls back to
*        the generic error renderer when `self.error` is set.
*
* Tool configuration (`tool_config.ddo_map`) is a plain-object array declaring every
* component/section that the tool needs. Each entry mirrors a standard ddo (tipo,
* section_tipo, section_id, model, mode, lang, …).  The build step resolves these
* into live instances stored in `self.ar_instances`.
*
* Exported symbols:
*   tool_common   — base constructor (prototype methods assigned below)
*   wire_tool     — prototype-wiring factory
*   open_tool     — public tool launcher
*   is_tool_attached — attach-mode state probe (tool name + caller)
*   load_component — component loader for use inside tool render code
*/



// imports
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {
		ApiError,
		CLIENT_ERROR,
		is_api_error,
		response_data
		} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {register_tool_error_labels} from '../../../core/common/js/render_api_error.js'
	import {
		clone,
		dd_console,
		printf,
		open_window,
		load_style,
		tool_css_url
		} from '../../../core/common/js/utils/index.js'
	import {render_error} from './render_tool_common.js'



/**
* TOOL_COMMON
* Base constructor for tool instances.
* Provides shared initialization, build, render, and utility methods for all tools.
* Concrete tool constructors (e.g. `tool_export`) call this implicitly; lifecycle
* methods are attached via `tool_common.prototype.*` assignments below.
*
* @returns {boolean} Always true (constructor sentinel, following Dédalo convention).
*/
export const tool_common = function(){

	return true
}//end tool_common



/**
* INIT
* Generic tool initialiser.  Seeds all well-known tool properties from `options`
* and resolves the caller instance.
*
* Two caller-resolution paths exist:
*   a) **Modal path** — `options.caller` is already a live instance (the component
*      or section that launched the tool in the same window).
*   b) **New-window path** — `options.caller` is null; the URL `?raw_data=` param
*      carries an LZString-compressed JSON object:
*        { caller_ddo: {...}, tool_config: {...}, caller_options: {...} }
*      This method decompresses it, resolves and builds the caller via `get_instance`,
*      and sets `self.caller_is_calculated = true` so `build` can skip re-instantiating
*      the already-resolved caller.
*
* `tool_config` resolution cascade (when not provided directly):
*   1. `caller.config.tool_context.tool_config` — used by section-level tools
*      (e.g. transcription) where the config travels via `caller.config`.
*   2. `caller.tools.find(el => el.model === self.model).tool_config` — component
*      tools registered in the component's tools array.
*   3. Synthetic fallback — a minimal ddo_map entry pointing at the caller itself,
*      so the tool always has at least one element to work with.
*
* A `section_id: 'self'` placeholder in a ddo_map entry is resolved here to the
* actual section_id from the caller, preventing stale placeholder strings reaching
* the API.
*
* Sets `self.is_init = true` as a one-shot guard; a second call logs an error and
* returns false without re-initialising.
*
* @param {Object} options - Configuration object for tool initialization
* @param {Object|null} [options.caller] - Live caller instance (modal path) or null
*   (new-window path, where the caller is rebuilt from URL params)
* @param {string} options.lang - Language code, e.g. 'lg-eng'
* @param {string} [options.mode='edit'] - Tool render mode
* @param {string} options.model - Tool model name, e.g. 'tool_indexation'
* @param {string} [options.section_id] - Section ID the tool operates on
* @param {string} [options.section_tipo] - Section tipo the tool operates on
* @param {Object} [options.tool_config] - Tool configuration object containing ddo_map
* @param {Object} [options.config] - Installation-specific configuration (e.g. machine
*   translation settings); stored as `self.config`
* @returns {Promise<boolean>} true on success; false if already initialised or invalid options
*/
tool_common.prototype.init = async function(options) {
	const self = this

	if(SHOW_DEVELOPER===true) {
		dd_console(`init tool options`, 'DEBUG', options)
	}

	// options validation
		if (!options || typeof options !== 'object') {
			console.error('Invalid init options:', options);
			return false
		}

	// safe init double control. To detect duplicated events cases
		if (self.is_init) {
			console.error('Duplicated init for element:', self);
			if(SHOW_DEBUG===true) {
				alert('Duplicated init element');
			}
			return false
		}

	// status update
		self.status = 'initializing'

	// options
		self.model			= options.model
		self.section_tipo	= options.section_tipo //
		self.section_id		= options.section_id
		self.lang			= options.lang
		self.mode			= options.mode || 'edit'
		self.config			= options.config // specific configuration that define, in current installation, things like machine translation will be used.
		self.tool_config	= options.tool_config
		self.caller			= options.caller
		// caller_options. Arbitrary per-open data from whoever opened the tool
		// (e.g. the indexation grid's clicked tag_id). The NEW-WINDOW path sets
		// it below, out of the URL payload; this is the DIRECT (modal) path,
		// where view_modal forwards it through the instance options. Without
		// this line the channel dead-ends in modal mode: view_modal received
		// caller_options and dropped it on the floor.
		self.caller_options	= options.caller_options ?? null

		// caller. Could be direct assigned (modal) or by URL caller_id (new window)
			// notify caller is already calculated (new window case)
			// When the tool opens in a new browser window there is no live caller
			// object — it must be reconstructed from URL params.
			self.caller_is_calculated = !self.caller
			// caller fallback to window.opener.callers variable or local data base
			if (!self.caller) {

				// re-build from caller_ddo
				// New-window path: the caller info was compressed and injected into the
				// URL as `raw_data` by view_window(). Decompress → parse → rebuild.
					// searchParams
					const searchParams = new URLSearchParams(window.location.search)
					// raw_data
					const raw_data = searchParams.get('raw_data') // null if absent

					if (raw_data) {

						try {

							// Note that url param 'url_data' is an object stringify-ed and compressed-encoded
							// Expected raw_data decoded is an object as
							// {
							//	 caller_ddo : object {...},
							//	 tool_config : object {...}
							// }
							// Lazy (CONVENTIONS.md §2, rationale 3 — rarely hit): only a tool
							// opened in its own window carries raw_data; keeps lz-string off
							// the boot graph (page_load_budget_native).
							const { LZString: lzstring } = await import('/dedalo/lib/lz-string/lz-string.js')
							const url_data_string	= lzstring.decompressFromEncodedURIComponent(raw_data)
							if (!url_data_string) {
								throw new Error('Decompression returned empty result')
							}
							const url_data_object	= JSON.parse(url_data_string)
							if (!url_data_object || typeof url_data_object !== 'object') {
								throw new Error('Parsed URL data is not a valid object')
							}
							const caller_ddo		= url_data_object.caller_ddo
							const tool_config		= url_data_object.tool_config
							const caller_options	= url_data_object.caller_options

							// debug
							if(SHOW_DEBUG===true) {
								console.log(')) tool common url_data_object:', url_data_object);
							}

							// set and build caller
							if (!caller_ddo) {
								throw new Error('Missing caller_ddo in URL data')
							}

							// dataframe
							// Preserve the caller_dataframe reference that was serialised into
							// the DDO so the new-window tool can identify its paired data row.
							self.caller_dataframe = caller_ddo.caller_dataframe ?? null

							self.caller = await get_instance( caller_ddo )

							if (self.caller) {

								// set current tool as caller
								// Back-link so the rebuilt caller can reference its owning tool.
								self.caller.caller = self

								// set caller options
								self.caller_options = caller_options ?? null

								// set label (see self.view_window())
								self.caller.label = caller_ddo.label ?? null

								// build caller when is not section
								// Sections are built by the time machine (TM) flow instead;
								// building them here would create a duplicate build cycle.
								if(caller_ddo.model!=='section'){
									// build only when the caller is a component, section will build by tm
									await self.caller.build(true)
								}

								// set tool_config
								self.tool_config = tool_config
							}
						} catch (error) {
							console.error('Error decoding/parsing raw_data from URL:', error, raw_data);
						}
					}else{
						console.error('Error. Unable to get raw_data from URL for caller_ddo:', window.location.search);
					}
			}

			// Check if the caller is available
			if (!self.caller) {

				// caller is not mandatory, but we alert for possible mistakes
				// Some tools (e.g. tool_dd_label) intentionally operate without a
				// caller; for all others this is an unexpected state and is flagged.

				self.error = `Warning. Empty caller !`
				console.warn(self.error, self)

			}else{

				// tool_config. Contains the needed ddo_map
				// Resolve tool_config through a three-level cascade when it wasn't
				// supplied directly (e.g. when the tool was opened programmatically
				// without a pre-built tool_config).
				if (!self.tool_config) {

					if (self.caller.config && self.caller.config.tool_context) {

						// section_tool case
						// Tools attached to a section toolbar surface their config
						// via caller.config.tool_context (e.g. the transcription tool).

						// from caller config (transcription case for example)
						self.tool_config = clone(self.caller.config.tool_context.tool_config)

					}else if (self.caller.tools) {

						// component case
						// Component-level tools store their config in the component's
						// `tools` array; locate the matching entry by model name.

						const tool_found = self.caller.tools.find(el => el.model===self.model)
						self.tool_config = tool_found?.tool_config || null
					}

					// final fallback
					// When no stored tool_config is found, synthesise a minimal one that
					// points the tool at the caller component itself.  This keeps the build
					// step from crashing in edge cases (ad-hoc tool launches, tests).
						if (!self.tool_config) {

							// fallback
								self.tool_config = {
									ddo_map : [{
										tipo				: self.caller.tipo,
										section_tipo		: self.caller.section_tipo,
										section_id			: self.caller.section_id,
										model				: self.caller.model,
										mode				: self.caller.mode, //'edit',
										lang				: self.caller.lang,
										role				: 'main_element',
										// (!) For component_dataframe callers, thread the
										// caller_dataframe reference into the synthetic entry
										// so the tool operates on the correct row.
										caller_dataframe	: (self.caller.model==='component_dataframe')
											? self.caller_dataframe
											: null
									}]
								}
								if(SHOW_DEBUG===true) {
									console.warn("-> tool_common init final fallback case self.tool_config:", self.tool_config);
								}
						}
				}

				// parse ddo_map section_id
				// Replace the literal string 'self' placeholder with the actual
				// section_id from the caller.  The placeholder is used in registered
				// tool configs to mean "same record as the caller"; it must be
				// resolved here before the ddo_map entries are passed to get_instance.
				if (self.tool_config?.ddo_map) {
					self.tool_config.ddo_map.forEach(el => {
						if (el.section_id==='self' && el.section_tipo===self.caller.section_tipo) {
							el.section_id = self.caller.section_id || self.caller.section_id_selected
						}
					})
				}
			}

	// set some common vars
		self.node			= null
		self.type			= 'tool'
		self.ar_instances	= []
		self.events_tokens	= []
		self.get_tool_label	= get_tool_label // function get_label called by the different tools to obtain the own label in the current lang. The scope is for every tool.

	// set caller_dataframe default if not already set
		if (self.caller_dataframe === undefined) {
			self.caller_dataframe = null
		}

	// mark as initialized (after all async ops succeeded)
		self.is_init = true

	// set status
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Generic tool build function.
* Loads the tool's CSS, instantiates every element declared in `tool_config.ddo_map`,
* and — when `autoload` is true — fetches the tool's persisted context object from
* the API (component_json `dd1353` inside the tool-registered section `dd1324`).
*
* The default ddo_map loader builds all elements in parallel (Promise.all) except:
*   - Entries with `autoload: false` are skipped entirely.
*   - `model: 'menu'` entries are skipped (menus are resolved separately).
*   - ddo_map entries that match the caller's tipo+section_tipo when the caller is a
*     section are skipped to avoid a double-build (tool_diffusion performance fix).
*   - In the new-window path (`caller_is_calculated`), the entry whose tipo matches
*     the already-rebuilt caller is recycled rather than rebuilt.
*
* A concrete tool may override the default loader by passing
* `options.load_ddo_map = async function() { … }`, which completely replaces the
* default and is responsible for populating `self.ar_instances`.
*
* The API context object (when autoloaded) is stored at `self.context` and its
* `config` subtree is mirrored to `self.config`.  Calling build with
* `autoload = true` a second time is treated as an error because the context is
* already present.
*
* @param {boolean} [autoload=false] - When true, fetches the tool's registered
*   context from the API (`get_element_context` action on dd1353).
* @param {Object} [options={}] - Optional build overrides
* @param {Function} [options.load_ddo_map] - Custom async function that builds the
*   ddo_map elements and populates `self.ar_instances`; replaces the default loader
*   entirely when provided.
* @returns {Promise<boolean>} Resolves true when all elements are built successfully.
*/
tool_common.prototype.build = async function(autoload=false, options={}) {

	const self = this

	// status update
		self.status = 'building'

	// load self style
		// (!) The version query string busts the browser cache on upgrades.
		// load_style deduplicates: a second call for the same URL is a no-op.
		await load_style( tool_css_url(self.model) )

	// options
		// load_ddo_map could be a callback or the default loader function
		const load_ddo_map = typeof options.load_ddo_map==='function'
			? options.load_ddo_map
			: async function() {
				// default loads all elements inside ddo_map
				const ar_promises		= []
				const ddo_map			= self.tool_config && self.tool_config.ddo_map
					? self.tool_config.ddo_map
					: []

				const ddo_map_length = ddo_map.length
				for (let i = 0; i < ddo_map_length; i++) {

					// el. components / sections / areas used by the tool defined in tool_config.ddo_map
						const el = ddo_map[i]

					// skip caller ddo item when is section (case tool_diffusion very slow)
					// When the caller is a section and the ddo entry maps to that same
					// section, building it here would duplicate a costly section build.
						if (self.caller && self.caller.model==='section' && self.caller.tipo===el.tipo && self.caller.section_tipo===el.section_tipo) {
							// self.ar_instances.push(self.caller)
							continue
						}

					// skip autoload false.
					// Individual ddo_map entries may opt out of automatic loading;
					// the tool render code is then responsible for building them on demand.
						if(el.autoload===false){
							continue
						}

					// menu skip ddo from menu
						if (el.model==='menu') {
							// console.warn('Ignored menu ddo:', el);
							continue
						}

					// lang. If is defined in properties, parse and use it, else use the tool lang
					// taking care to do not re-parse the value
					// Priority: explicit el.lang > non-translatable (nolan) > current data lang.
						const current_el_lang = el.lang
							? el.lang // already exists
							: (typeof el.translatable!=='undefined' && el.translatable===false)
								? page_globals.dedalo_data_nolan // lg-nolan
								: page_globals.dedalo_data_lang // current data lang (DEDALO_DATA_LANG)

					ar_promises.push( (async () => {

						// new window cases. Caller is calculated, NOT from existing component, so we recycle the instance
						// In the new-window path the caller was rebuilt during init(); if this
						// ddo_map entry is the same element, reuse the existing instance instead
						// of creating a duplicate (which would cause an is_init guard error).
							if (self.caller_is_calculated && el.tipo===self.caller.tipo) {
								console.log('Used already resolved caller instance:', self.caller);
								return self.caller
							}

						const element_options = {
							model				: el.model,
							mode				: el.mode,
							view 				: el.view,
							tipo				: el.tipo,
							section_tipo		: el.section_tipo,
							section_id			: el.section_id,
							lang				: current_el_lang,
							type				: el.type,
							properties			: el.properties || null,
							id_variant			: self.model,  // id_variant prevents id conflicts
							caller				: self, // set tool as caller of the component :-)
							caller_dataframe	: el.caller_dataframe || null
						}

						// init and build instance
							const element_instance = await get_instance(element_options) // load and init
							await element_instance.build(true) // build, loading data
							return element_instance
					})())
				}//end for (let i = 0; i < ddo_map.length; i++)

				// set on finish
				// All element promises run concurrently; collect results once all settle.
				self.ar_instances = await Promise.all(ar_promises)

				return true
			  }//end async function() load_ddo_map

	// load_ddo_map. Exec load ddo_map elements
		await load_ddo_map()

	// load data if is not already received as option
		if (autoload===true) {
			if (self.context) {
				// catch invalid call. Page build must be false except the first start page
				// Calling build(true) when context already exists is a programming error —
				// it would overwrite context that was loaded by a prior build cycle.
				console.error('Error. Ignored call to tool_common build with autoload=true. Tool already have context!', self.context);
			}else{

				// tool rqo. Create the basic rqo to load tool config data stored in component_json tipo 'dd1353'
				// The tool's registered context is stored under section 'dd1324' (tool_registered)
				// and exposed via component_json 'dd1353'.  `get_element_context` resolves the
				// correct record by matching `source.model` to the tool's registered name.
					const rqo = {
						action			: 'get_element_context',
						prevent_lock	: true,
						// tool source for component JSON that stores full tool config
						source : {
							model			: self.model,
							section_tipo	: self.section_tipo,
							section_id		: self.section_id,
							mode			: self.mode,
							lang			: self.lang
						}
					}

				// load data. Load section data from db of the current tool.
				// Tool data configuration is inside the tool_registered section 'dd1324' and parsed into component_json 'dd1353',
				// The tool info was generated when it was imported / registered by admin
					const api_response = await data_manager.request({
						body : rqo
					})
					if (SHOW_DEBUG) {
						console.log('tool common api_response: ' , api_response)
					}
					// (!) THE payload accessor: the envelope carries `data`, not `result`.
					// Reading `.result` here silently left every tool context null, so
					// each tool header rendered with an empty label.
					self.context = response_data(api_response)?.[0] || null

				// config update
					if (self.context) {
						self.config = self.context.config
					}else{
						console.error('Error. Tool context not loaded from API response:', api_response);
					}

				// debug
					if(SHOW_DEBUG===true) {
						// console.log("/// [tool_common.build] api_response:", api_response);
						dd_console(`[tool_common.build] TOOL: ${self.model} api_response:`, 'DEBUG', api_response)
					}
			}
		}//end if (autoload===true && !self.context)

	// refusal sentences. A tool refuses with a core code + `details.reason_key`; the
	// sentence for that key is this tool's own label `reason_<key>` (register.json),
	// which render_api_error.error_text can only reach through this registry
		register_tool_error_labels(self.model, self.context?.labels)

	// status update
		self.status = 'built'


	return true
}//end build



/**
* RENDER
* Entry-point render method mixed into every tool via `wire_tool`.
* Delegates to `common.prototype.render` for the normal path, but intercepts any
* error that was recorded on `self.error` during init/build and renders a
* human-readable error panel instead (via `render_error` from render_tool_common.js).
*
* This guard exists because tool lifecycle errors (missing caller, failed API calls,
* bad config) are often non-fatal from the page's perspective — the user should see
* a meaningful error in the tool panel rather than a blank widget or an uncaught
* rejection.
*
* @param {Object} [options={}] - Render options forwarded to common.prototype.render
* @param {string} [options.render_level] - Render depth: 'full' (default) or 'content'
* @returns {Promise<HTMLElement>} The rendered wrapper element, or the error panel element.
*/
tool_common.prototype.render = async function(options={}) {

	const self = this

	// call the generic common render or render tool generic error
	// (!) self.error is set as a string in init() — typeof check (not truthiness) is
	// intentional to distinguish an empty-string error from a truly absent property.
		const result = typeof self.error!=='undefined'
			? render_error(this, options)
			: await common.prototype.render.call(this, options);


	return result
}//end render



/**
* TOOL_REQUEST
* Convenience wrapper that builds and dispatches the standard `dd_tools_api /
* tool_request` RQO that every tool previously assembled by hand. The server runs
* the tool's `apiActions[action]` handler (`tools/<tool>/server/index.ts`) behind
* the dispatcher's gates (granted tool, declared action, permission gate).
*
* Security contract: the action MUST be a key of the tool server module's
* `apiActions`. Anything else is refused server-side (`tool.method_not_allowed`).
*
* Background mode: when `options.background = true`, the flag
* `background_running: true` is injected into the options object forwarded to
* the action. The server module must also list the action in `backgroundRunnable`;
* the server then queues the job and returns immediately with a job handle.
*
* Retries and idempotency: the transport (`data_manager.request`) resends a
* request whose attempt timed out, up to 5 attempts, and stamps every resendable
* request with an idempotency key the server's ledger de-duplicates by. That is
* right for a write and wrong for a lookup that calls a third-party service, which
* wants ONE attempt: pass `retries: 1` (no resend, so no key and no ledger entry)
* and, if the upstream is slow, a longer per-attempt `timeout`. An action that
* declares itself `readOnly` on the server is never ledgered, so a resend of it
* re-executes and answers its real outcome - which is why every call site of such
* an action passes the literal `retries: 1` (gated). The three transport options
* are forwarded ONLY when given and usable: an explicit `undefined` would override
* the transport's default.
*
* `prevent_lock` is accepted for call-site compatibility and has no effect (the
* server holds no session lock).
*
* @param {Object} options - Request options
* @param {string} options.action - Action key in the tool server module's `apiActions`, e.g. 'my_action'
* @param {Object} [options.options={}] - Options object forwarded verbatim to the action
* @param {boolean} [options.background=false] - When true, queues the action on the
*   server background runner; caller receives a job handle, not a direct result
* @param {string|null} [options.url=null] - Optional API endpoint URL override; when
*   null, uses the default data_manager endpoint
* @param {boolean} [options.prevent_lock=true] - Compatibility field, inert
* @param {number} [options.retries] - Transport attempts, an integer >= 1 (data_manager default 5); 1 = send once.
*   REQUIRED, as the literal `1`, at the call site of an action the server declares `readOnly`
*   (client_idempotency_tripwire): a read-only action is not ledgered, so a resend re-executes it
* @param {number} [options.timeout] - Per-attempt deadline in ms (data_manager default 5000)
* @param {boolean|null} [options.busy_notice] - Whether the slow-call "busy" notice is shown
*   (data_manager default: on, except for background actions and long timeouts)
* @returns {Promise<Object>} API envelope v2 `{ ok, request_id, data, error, ... }`
*/
tool_common.prototype.tool_request = async function(options) {

	const self = this

	// options
		const action		= options.action
		const fn_options	= options.options || {}
		const background	= options.background ?? false
		const url			= options.url ?? null
		const prevent_lock	= options.prevent_lock ?? true

	if (!action) {
		console.error('tool_request: missing action', options)
		return {result: false, msg: 'Error. tool_request: missing action', errors: ['missing action']}
	}

	// rqo
	// `create_source` builds the source descriptor the server uses to identify
	// which tool and which record the request targets.  `action` is embedded
	// inside source so the server dispatcher can route to the correct action.
		const rqo = {
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: prevent_lock,
			source			: create_source(self, action),
			options			: background===true
				? {...fn_options, background_running: true}
				: fn_options
		}

	// transport options. data_manager merges `{...defaults, ...options}`, so a key
	// present with the value `undefined` OVERRIDES its default — each is added only
	// when the caller gave a usable one. `retries` is the dangerous one: it decides
	// BOTH the idempotency stamp and the resend count, so only an integer >= 1 is
	// forwarded (data_manager normalises anything else to the default as well; a
	// caller bug must not depend on that last line of defence alone).
		const transport_options = {}
		if (Number.isInteger(options.retries) && options.retries>=1)	transport_options.retries	= options.retries
		if (options.timeout!==undefined)		transport_options.timeout		= options.timeout
		if (options.busy_notice!==undefined)	transport_options.busy_notice	= options.busy_notice

	// request
		const api_response = await data_manager.request({
			body : rqo,
			...(url ? {url} : {}),
			...transport_options
		})


	return api_response
}//end tool_request



/**
* WIRE_TOOL
* Stamps the standard shared prototype methods onto a concrete tool constructor,
* replacing the boilerplate assignments that each tool file used to repeat manually.
*
* Methods wired unconditionally:
*   render  → tool_common.prototype.render  (error-guarded render)
*   destroy → common.prototype.destroy      (shared instance teardown)
*   refresh → common.prototype.refresh      (shared re-render entry point)
*
* Methods wired conditionally (only when render_module defines them):
*   edit → render_module.prototype.edit  (edit-mode render)
*   list → render_module.prototype.list  (list-mode render)
*
* Concrete tools call this once at module load and may then assign additional
* prototype methods (e.g. `tool_export.prototype.save = …`) after the call —
* wire_tool does not clobber those later assignments.
*
* @param {Function} tool_constructor - The concrete tool constructor (e.g. `tool_export`)
* @param {Function} [render_module] - The tool's render constructor (e.g. `render_tool_export`);
*   optional — pass null/undefined for tools that have no separate render module
* @returns {Function} The same `tool_constructor` reference, now wired (for chaining convenience)
*/
export const wire_tool = function(tool_constructor, render_module) {

	tool_constructor.prototype.render	= tool_common.prototype.render
	tool_constructor.prototype.destroy	= common.prototype.destroy
	tool_constructor.prototype.refresh	= common.prototype.refresh
	// tool_request: the server round-trip. Part of the standard wiring: it was not,
	// so tool_dev_template (the scaffolder's source) and every tool copied from it
	// called self.tool_request on a prototype that lacked it ('not a function' —
	// how tool_sitebuilder shipped unable to reach its server).
	tool_constructor.prototype.tool_request	= tool_common.prototype.tool_request

	if (render_module) {
		if (typeof render_module.prototype.edit==='function') {
			tool_constructor.prototype.edit = render_module.prototype.edit
		}
		if (typeof render_module.prototype.list==='function') {
			tool_constructor.prototype.list = render_module.prototype.list
		}
	}

	return tool_constructor
}//end wire_tool



/**
* LOAD_COMPONENT
* Asynchronously instantiates, registers, and builds a single component inside a
* tool.  Use this inside tool render code when you need to load a component that
* was not declared in `tool_config.ddo_map` at build time, or when a user action
* switches the component being displayed (e.g. a section-type switcher).
*
* Lifecycle steps performed:
*   1. Resolves optional args (`matrix_id`, `data_source`, `caller_dataframe`).
*   2. Destroys any instances listed in `to_delete_instances`, removing them from
*      `self.ar_instances` first (reverse iteration to keep indices stable).
*   3. Calls `get_instance(instance_options)` — returns the cached instance if the
*      same key was already registered, or creates a new one.
*   4. Adds the new instance to `self.ar_instances` if not already present (prevents
*      duplicates on repeated calls with identical options).
*   5. Calls `component_instance.build(true)` to load data from the API.
*
* `id_variant` defaults to the owning tool's model name (`self.model`), which
* ensures the component ID is tool-scoped and avoids collisions with the same
* component rendered elsewhere on the page.
*
* `caller` is always set to the tool (`self`) so downstream code can detect that a
* component is running inside a tool context rather than inline on a section.
*
* @param {Object} options - Component load options
* @param {Object} options.self - The owning tool instance (provides `ar_instances`,
*   `model`, and any other tool-level state the component needs)
* @param {string} options.model - Component model name, e.g. 'component_input_text'
* @param {string} options.mode - Render mode: 'edit', 'list', 'search', etc.
* @param {string} options.tipo - Ontology tipo of the component, e.g. 'dd345'
* @param {string} options.section_tipo - Ontology tipo of the parent section
* @param {string} options.lang - Language tag, e.g. 'lg-eng'
* @param {string} [options.section_lang] - Language override for the section context
* @param {string} [options.type] - Instance type classifier (usually 'component')
* @param {string|number|null} [options.section_id=null] - Record ID; null for new records
* @param {string|null} [options.matrix_id=null] - Matrix record ID for matrix components
* @param {string|null} [options.data_source=null] - Alternate data source descriptor
* @param {string} [options.id_variant] - Key suffix to scope the instance ID;
*   defaults to the owning tool's model name to prevent cross-page collisions
* @param {Object[]} [options.to_delete_instances] - Existing instances to destroy
*   before loading the new one (used when swapping the displayed component)
* @param {boolean} [options.delete_dependencies=false] - Destroy the
*   `to_delete_instances` DEEP (their whole subtree: section_records, children).
*   Default false keeps the shallow destroy every other tool relies on;
*   tool_time_machine sets it so a superseded preview does not leave its subtree,
*   with that row's data, registered in the instances map
* @param {Object|null} [options.caller_dataframe=null] - Dataframe context for
*   `component_dataframe` callers; threads the row key through to the new instance
* @returns {Promise<Object>} The fully initialised and built component instance
*/
export const load_component = async function(options) {

	// options
		const self					= options.self
		const model					= options.model
		const mode					= options.mode
		const tipo					= options.tipo
		const section_tipo			= options.section_tipo
		const section_lang			= options.section_lang
		const lang					= options.lang
		const type					= options.type
		const section_id			= options.section_id || null
		const matrix_id				= options.matrix_id || null
		const data_source			= options.data_source || null
		const id_variant			= options.id_variant || self.model
		const to_delete_instances	= options.to_delete_instances
		const delete_dependencies	= options.delete_dependencies===true
		const caller_dataframe		= options.caller_dataframe || null

	// component instance_options
		const instance_options = {
			model				: model,
			mode				: mode,
			tipo				: tipo,
			section_tipo		: section_tipo,
			section_id			: section_id,
			lang				: lang,
			section_lang		: section_lang,
			type				: type,
			id_variant			: id_variant, // id_variant prevents id conflicts
			caller				: self // set current tool as component caller (to check if component is inside tool or not)
		}

		if (matrix_id) {
			instance_options.matrix_id = matrix_id
		}

		if (data_source) {
			instance_options.data_source = data_source
		}

		if (caller_dataframe) {
			instance_options.caller_dataframe = caller_dataframe
		}

	// get instance and init
		const component_instance = await get_instance(instance_options)

	// clean instances
	// Destroy and deregister stale instances before adding the new one.
	// Iterate in reverse so splice() does not shift unvisited indices.
		if (to_delete_instances && to_delete_instances.length>0) {
			for (let i = self.ar_instances.length - 1; i >= 0; i--) {
				const current_instance = self.ar_instances[i]
				if (to_delete_instances.includes(current_instance)) {
					// remove from array of instances and destroy
					self.ar_instances.splice(i, 1)
					await current_instance.destroy(
						true, // delete_self
						delete_dependencies, // delete_dependencies (default false: shallow)
						false // remove_dom
					)
				}
			}
		}

	// add component instance to current ar_instances if not already done
	// Guard against duplicate registration when `get_instance` returns a cached entry.
		const instance_found = self.ar_instances.find( el => el===component_instance )
		if (!instance_found) {
			self.ar_instances.push(component_instance)
		}

	// build
		await component_instance.build(true)


	return component_instance
}//end load_component



/**
* OPEN_TOOL
* Public entry point that opens any registered Dédalo tool in the appropriate
* visualisation mode.  Inits, builds, and renders (or attaches) the requested tool,
* dispatching to `view_window`, `view_modal` or `view_attach` based on `open_as`.
*
* Preferred usage: do NOT call `open_tool` directly from component code.
* Instead publish the `open_tool` event so that page-level observers can
* intercept, queue, and coordinate tool openings:
*
* ```js
* event_manager.publish('open_tool', {
*   caller: self,
*   tool_context: {
*     css: "/v6/tools/tool_lang/css/tool_lang.css",
*     icon: "/v6/tools/tool_lang/img/icon.svg",
*     label: "Translation",
*     mode: "edit",
*     model: "tool_lang",
*     name: "tool_lang",
*     properties: {open_as: 'modal', windowFeatures: null},
*     section_id: 8,
*     section_tipo: "dd1324",
*     show_in_component: true
*   }
* })
* ```
*
* The event is fired by the tool button created with method ui.build_tool_button.
* When the user triggers the click event, a publish 'open_tool' is made.
*
* `tool_context` resolution:
*   - Object — used directly (cloned to break circular references).
*   - String — treated as a model name; the function fetches the full context
*     from the API via `get_element_context` before proceeding.
*   - null / undefined → early return false.
*
* `open_as` priority:
*   options.open_as > tool_context.properties.open_as > 'modal' (hardcoded default).
*
* `open_as` values:
*   - 'window' — a separate browser window (`view_window`).
*   - 'modal'  — a Dédalo modal panel in the current window (`view_modal`). Any
*     other value also lands here (registration refuses anything outside the
*     closed set modal | window | attach; the retired 'tab'/'popup' are gone).
*   - 'attach' — no panel at all: the tool decorates its live caller (e.g. a
*     toolbar on a component's map) through its own `attach()` / `detach()`
*     methods (`view_attach`). A second open of the same tool on the same caller
*     detaches it (toggle).
*
* `windowFeatures` priority:
*   options.windowFeatures > tool_context.properties.windowFeatures > null.
*
* @param {Object} options - Tool open options
* @param {Object} options.caller - Live caller instance (component or section) that
*   triggered the tool; forwarded to the tool and used to refresh after close
* @param {Object|string} options.tool_context - Full tool context object (as stored
*   in the tool registration), or a model name string to resolve from the API
* @param {Object|null} [options.caller_options=null] - Arbitrary extra data passed
*   through to the tool; tool-specific, not interpreted here
* @param {string|null} [options.open_as=null] - Visualisation mode override:
*   'window' | 'modal' | 'attach' (the closed set; anything else falls back to 'modal');
*   when null, falls back to `tool_context.properties.open_as` or 'modal'
* @param {string|Object|null} [options.windowFeatures=null] - Browser window-features
*   string ('left=100,top=100,width=320,height=320') or object
*   ({ left: 100, top: 0, width: 760, height: 500 }); overrides the context value
* @returns {Promise<Object|boolean>} The tool instance (modal and attach paths) or the
*   new Window object (window path); false on validation failure, missing context,
*   a refused/failed attach, or an attach toggle-off
*/
export const open_tool = async (options) => {

	// debug
		if(SHOW_DEBUG===true) {
			console.warn("------ open_tool call options:",options);
		}

	// options validation
		if (!options || typeof options!=='object') {
			console.error('open_tool: invalid options', options);
			return false
		}

	// options
		// tool_context. If is string, resolve context from API using value as model
		// When the caller passes a model name string, fetch the registered context object
		// from the API (the same payload that `build(autoload=true)` would load later).
		const tool_context = typeof options.tool_context==='string'
			? await (async ()=>{
				// tool rqo. Create the basic rqo to load tool config data stored in component_json tipo 'dd1353'
				const rqo = {
					action			: 'get_element_context',
					prevent_lock	: true,
					source			: {
						model : options.tool_context // expected name as 'tool_upload'
					}
				}
				try {
					const api_response = await data_manager.request({
						body : rqo
					})
					const tool_context_data = response_data(api_response)
					if (tool_context_data && tool_context_data[0]) {
						return tool_context_data[0] // tool context object
					}
					return null
				} catch (error) {
					console.error('open_tool: failed to resolve tool_context from API:', error);
					return null
				}
			  })()
			 : options.tool_context
				? clone(options.tool_context) // (!) full clone here to avoid circular references
				: null

		// check tool context
		// A missing context is not recoverable — the tool cannot be identified or
		// configured without it.  Common cause: tool not registered for this user/role.
		if (!tool_context) {
			console.error('The tool cannot be opened without context. Check the tools registration in the current user\'s profile.');
			return false
		}

		// caller. Instance that calls the tool, normally a component or section
		const caller = options.caller
		// caller_options. Object with additional data for the tool
		const caller_options = options.caller_options || null
		// open_as. Mode of tool visualization: modal | window | attach
		// Priority: explicit override > registered context property > hardcoded 'modal'.
		const open_as = options.open_as
			? options.open_as // overwrite context value when is passed
			: tool_context?.properties?.open_as
				? tool_context.properties.open_as
				: 'modal' // default is 'modal'
		// windowFeatures. Features to pass to the tool visualizer
		// (normally standard JAVASCRIPT text features like: "left=100,top=100,width=320,height=320")
		const current_windowFeatures = options.windowFeatures
			? options.windowFeatures // overwrite context value when is passed
			: tool_context?.properties?.windowFeatures
				? tool_context.properties.windowFeatures
				: null

	// attach. No panel: the tool is built straight onto its caller (toggle on a
	// second open). Routed before the window/modal split below.
	if (open_as==='attach') {
		return await view_attach({
			tool_context	: tool_context, // object
			caller			: caller, // object like component_geolocation instance
			caller_options	: caller_options
		})
	}

	// open tool visualization
	// 'window' is the only open_as value that uses a separate browser window;
	// 'modal' (and any unexpected value) goes through view_modal.
	return (open_as==='window')
		? await view_window({
			tool_context	: tool_context, // object
			caller			: caller, // object like component_input_text instance
			caller_options	: caller_options,
			windowFeatures	: current_windowFeatures // string like 'left=100,top=100,width=320,height=320'
		  })
		: await view_modal({
			tool_context	: tool_context, // object
			caller			: caller, // object like component_input_text instance
			caller_options	: caller_options,
			open_as			: open_as, // string, 'modal'
			windowFeatures	: current_windowFeatures // string like 'left=100,top=100,width=320,height=320'
		  })
}//end open_tool



/**
* OPEN_TOOL_MODALS
* Keys (tool name + caller id_base + lang) of the tool modals currently open or
* opening. Lets view_modal refuse a second open synchronously, before the async
* tool load, so repeated clicks on a slow network never stack two modals.
*/
const open_tool_modals = new Set()



/**
* LOAD_WINDOW_FEATURES
* The windowFeatures grammar (window_features.js), loaded on the first tool
* that DECLARES features instead of with the page.
* Lazy (CONVENTIONS.md §2, rationale 3): only opening a tool needs it, and a
* static import here put it on the cold-boot critical path of every page
* (tool_common.js is on it) — one more request before first paint, counted by
* test/unit/page_load_budget_native.test.ts. A tool with no windowFeatures
* never loads it: there is nothing to parse.
* @returns {Promise<{parse_window_features: Function, parse_modal_features: Function}>}
*/
const load_window_features = () => import('./window_features.js')



/**
* VIEW_MODAL
* Opens the tool inside a Dédalo modal panel within the current window.
* Handles the full tool lifecycle: instance resolution, spinner UI, build, render,
* header wiring, and modal close/cleanup.
*
* Open-first: the modal (placeholder header + spinner) is attached synchronously on
* the click; the slow part — `get_instance` (tool ES module import + init), the tool
* CSS, build and render — runs behind the spinner. On a slow network the user sees
* the tool open at once instead of a frozen page.
*
* Toggle behaviour: a second open of the same tool for the same caller while one is
* open or still loading is refused synchronously (`open_tool_modals`), returning
* false. If `get_instance` returns an already-running instance (status other than
* 'initialized', e.g. opened through another path), the just-opened modal is dropped
* and false is returned. A modal closed while loading destroys the late instance
* unless a reopen of the same tool+caller is already awaiting it.
*
* Tool instance ID scoping: `id_variant` is set to `caller.id_base` so that the
* same tool model opened from two different caller components gets separate instance
* registry entries and does not collide in `instances_map`.
*
* Modal close flow:
*   1. `modal.remove()` — explicit DOM removal is required because this `on_close`
*      overwrites the default close handler; the default would have called remove().
*   2. If the tool defines `on_close_actions(mode)`, that custom hook runs (e.g.
*      tool_print uses this to flush layout state).
*   3. Otherwise the standard cleanup runs: `tool_instance.destroy(true, true, true)`,
*      `caller.refresh({ refresh_id_base_lang: true })`, and re-activation of the caller.
*
* `windowFeatures` (object form) is applied as inline styles on `modal.modal_content`,
* allowing per-tool size customisation via the registration config:
*   `{"windowFeatures": {"width": "34rem", "maxWidth": "100%"}}`
* Only the size properties are accepted (`width`, `minWidth`, `maxWidth`, `height`,
* `minHeight`, `maxHeight`; `parse_modal_features`, window_features.js) — any other
* key throws, naming it.
*
* @param {Object} options - Modal view options
* @param {Object} options.tool_context - Full tool context object (name, model, css,
*   icon, label, properties, …) — used to construct the instance options and UI
* @param {Object} options.caller - Live caller instance; required (guards early exit)
* @param {Object|null} [options.caller_options] - Extra data forwarded to the tool
* @param {string} [options.open_as] - The resolved mode, forwarded verbatim ('modal');
*   informational only — modal rendering does not depend on it
* @param {Object|null} [options.windowFeatures] - Object whose keys are CSS property
*   names and values are CSS values, applied to `modal.modal_content` to size the modal
* @returns {Promise<Object|boolean>} Resolves once the tool instance is loaded (before
*   build/render) with the instance; false when the caller is missing, the tool is
*   already open (toggle) or the modal was closed while loading
*/
const view_modal = async function(options) {

	// options
		const caller			= options.caller
		const windowFeatures	= options.windowFeatures || null

	// validate caller
		if (!caller) {
			console.error('view_modal: missing caller');
			return false
		}

	// tool context (clone to avoid mutating the passed-in object)
	// Merge caller language and type into a fresh context object so the tool
	// instance key includes the correct lang and 'tool' type classifier.
		const tool_context = Object.assign({}, options.tool_context || {}, {
			lang		: caller.lang,
			type		: 'tool',
			id_variant	: caller.id_base // prevent instance id collisions
		})

	// instance options
		const instance_options = Object.assign({
			caller			: caller, // add caller to tool_context (only to refresh it on close the tool)
			caller_options	: options.caller_options || null // per-open data, e.g. the tag_id to land on
		}, tool_context)

	// opening guard (toggle tool)
	// Synchronous, so a second click while the first open is still loading
	// (slow network: module import + build) is refused before a second modal
	// exists. Cleared on modal close.
		const open_key = `${tool_context.name}_${caller.id_base}_${caller.lang}`
		if (open_tool_modals.has(open_key)) {
			return false
		}
		open_tool_modals.add(open_key)

	// modal_styles
	// Parsed BEFORE anything is built: the keys are a closed list of size
	// properties (window_features.js) and any other is refused naming the key —
	// the value is registry data, never trusted as style. The grammar module is
	// loaded here, on the first tool that declares features, and AFTER the
	// synchronous guard above (an await before it would let a second click
	// through); a refusal releases the guard so the tool can be opened again
	// once its registration is fixed.
		let modal_styles = {}
		if (windowFeatures) {
			try {
				const {parse_modal_features} = await load_window_features()
				modal_styles = parse_modal_features(windowFeatures)
			} catch (error) {
				open_tool_modals.delete(open_key)
				throw error
			}
		}

	// tool_instance. Resolved inside the modal spinner callback (see below), so the
	// modal opens on the click and the slow part (tool ES module import, CSS, build)
	// runs behind the spinner instead of before anything is painted.
		let tool_instance = null
		let modal_closed = false // set by modal.on_close

	// load_tool_instance. Instance load / recover + tool CSS.
		const load_tool_instance = async () => {

			// load tool CSS
			// Awaited (below) to prevent a first paint of the tool before its stylesheet
			// is applied (build() awaits its own load_style the same way). Started in
			// PARALLEL with the module import: sequenced after it, it cost one extra
			// network round trip on every first open (~0.6s on a slow network).
			// (!) tool_css_url, exactly as build() does, so the two loads dedup to a
			// single request — the server css.url is unversioned, and load_style
			// keys on the exact string, so a bare url would fetch twice.
			const css_url = tool_context.model
				? tool_css_url(tool_context.model)
				: tool_context.css?.url

			const [instance] = await Promise.all([
				get_instance(instance_options),
				css_url ? load_style(css_url) : null
			])

			// already running elsewhere (status other than 'initialized'): toggle-close
			if (instance && instance.status && instance.status!=='initialized') {
				return {instance, already_open : true}
			}

			return {instance, already_open : false}
		}

	// resolve. view_modal resolves with the tool instance once it is loaded (or
	// false), preserving the open_tool return contract.
		let resolve_view
		const view_promise = new Promise(resolve => { resolve_view = resolve })

	// modal
	// Construct a placeholder header + body immediately so the modal can open with a
	// loading spinner while the async build/render runs inside the callback.
		const loading_label = get_label.loading || 'Loading tool..'
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: `tool_header ${tool_context.name} header`
		})
		const header_name_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'tool_name_container',
			parent			: header
		})
		const header_label = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label',
			parent			: header_name_container
		})
		if (tool_context.icon) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button white',
				style			: {
					'-webkit-mask'	: `url('${tool_context.icon}')`,
					'mask'			: `url('${tool_context.icon}')`
				},
				parent			: header_label
			})
		}
		header_label.append(tool_context.label || tool_context.name || '')
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description',
			text_content	: loading_label,
			parent			: header_name_container
		})
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: `wrapper_tool ${tool_context.name} edit body`,
			text_content	: loading_label
		})
		body.style.minHeight = '15rem'
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: null,
			callback	: (dd_modal) => {

				ui.load_item_with_spinner({
					container			: body,
					label				: tool_context.label,
					preserve_content	: false,
					replace_container	: true,
					callback			: async () => {

						// invalid tool common render
						// Fallback renderer used when the tool fails to build or render —
						// surfaces a readable error in the modal instead of a blank panel.
						const render_invalid_tool = (error) => {
							// Create a wrapper element with a message indicating the tool is invalid
							const msg = tool_instance
								? `${tool_instance.context?.label} (${tool_instance.model}) called from: ${caller.label} (${caller.model} - ${caller.tipo})`
								: `Called from: ${caller.label} (${caller.model} - ${caller.tipo})`
							const wrapper = ui.create_dom_element({
								element_type	: 'div',
								text_content	: msg,
								class_name		: 'body content'
							});
							wrapper.slot = 'body';

							// surface the actual error to the user instead of console-only
							if (error) {
								ui.create_dom_element({
									element_type	: 'div',
									class_name		: 'content_data tool tool_error content_data_error',
									text_content	: 'Error: ' + (error.message || error) + '. Try to close the tool and re-open it',
									parent			: wrapper
								});
							}

							// Create and configure the tool header for the invalid tool case
							const tool_header = ui.create_dom_element({
								element_type	: 'div',
								inner_html		: 'Invalid tool configuration',
								class_name		: 'tool_name_container label header'
							});
							tool_header.slot = 'header';
							header.replaceWith(tool_header);

							return wrapper;
						}

						// load the tool instance (module import + CSS) behind the spinner
						let loaded
						try {
							loaded = await load_tool_instance()
						} catch (error) {
							console.error(error, caller);
							resolve_view(false)
							return render_invalid_tool(error);
						}

						// already open elsewhere (toggle): drop this modal, keep that one
						if (loaded.already_open) {
							open_tool_modals.delete(open_key)
							modal.remove()
							resolve_view(false)
							return null
						}

						// closed by the user while loading: nothing to render.
						// (!) Destroy the late instance only when no newer open of the
						// same tool+caller is in progress: get_instance de-dups in-flight
						// builds, so a reopen during this load awaits the SAME instance,
						// and destroying it here would hand that open a dead tool (caller
						// nulled — its on_close_actions then threw on caller.refresh).
						if (modal_closed) {
							if (!open_tool_modals.has(open_key)) {
								loaded.instance?.destroy?.(true, true, true)
							}
							resolve_view(false)
							return null
						}

						tool_instance = loaded.instance
						resolve_view(tool_instance || false)

						// no valid tool instance case
						if (!tool_instance) {
							return render_invalid_tool();
						}

						try {
							// Build and render the tool instance
							await tool_instance.build(true);
							// closed while building (on_close already destroyed it)
							if (modal_closed) {
								return null
							}
							const wrapper = await tool_instance.render();

							// Ensure the wrapper contains a valid tool header
							// The concrete tool's render() must produce a node with a
							// `.tool_header` child; this guard catches misconfigured renders
							// early and surfaces a clear error rather than a silent blank.
							if (!wrapper.tool_header) {
								throw new Error('Invalid tool wrapper: missing tool_header');
							}

							// Set up the header
							// Promote the rendered tool_header into the modal's <slot name="header">
							// so modal chrome (close button, drag handle) wraps the tool's own header.
							wrapper.tool_header.slot = 'header';
							wrapper.tool_header.classList.add('header');
							header.replaceWith(wrapper.tool_header);

							// Set up the body
							wrapper.slot = 'body';
							// body.replaceWith(wrapper);

							// ! note that function 'load_item_with_spinner' will replace
							// body content with tool instance rendered node

							// Link the wrapper to the modal
							// Back-reference allows the tool to reach the modal (e.g. to
							// adjust its own height or to call modal.close() programmatically).
							wrapper.modal = modal;

							// Return the configured wrapper
							return wrapper;
						} catch (error) {
							console.log('tool_instance:', tool_instance);
							console.error(error, caller);
							return render_invalid_tool(error);
						}
					}
				})
			}
		})
		modal.on_close	= () => {

			modal_closed = true
			open_tool_modals.delete(open_key)

			// remove modal from DOM (original on_close was overwritten,
			// so we must call remove() explicitly to avoid DOM leak)
			modal.remove()

			if (tool_instance && typeof tool_instance.on_close_actions==='function') {

				// custom actions
				// Tools that need special teardown (save state, flush caches, etc.)
				// define on_close_actions(mode) and it runs here instead of the
				// default destroy + refresh sequence below.
				tool_instance.on_close_actions('modal')

			}else if (tool_instance) {

				// Standard cleanup: destroy the tool, refresh the caller record to
				// pick up any changes the tool may have written, then re-focus caller.
				tool_instance.destroy(true, true, true)
				caller.refresh({
					refresh_id_base_lang : true
				})
				.then(()=>{
					// re-select the caller component
					dd_request_idle_callback(
						() => {
							ui.component.activate(caller)
						}
					)
				})
				.catch(err => {
					console.error('view_modal: caller.refresh failed:', err)
				})
			}

			// re-select the caller component
			// Always re-activate the caller component after the modal closes,
			// regardless of whether the tool defined custom close actions.
			if (caller.type==='component') {
				dd_request_idle_callback(
					() => {
						ui.component.activate(caller)
					}
				)
			}
		}

	// windowFeatures. To customize the modal size in a tool, set tool properties
	// `windowFeatures` like `{"windowFeatures":{"width":"34rem","maxWidth":"100%"}}`
	// Object form only (string form is for view_window); each key is a CSS property.
	// (parsed at the top of this function — a closed list of size properties)
		for (const [key, value] of Object.entries(modal_styles)) {
			modal.modal_content.style[key] = value
		}


	return view_promise
}//end view_modal



/**
* ATTACHING_TOOL_KEYS
* Attach keys (see get_attach_key) of the `open_as:'attach'` tools currently
* LOADING (instance load, build, first attach). Lets view_attach refuse a second
* click synchronously, before the async load, so a slow network never starts two
* attaches of the same tool on the same caller.
*/
const attaching_tool_keys = new Set()



/**
* ATTACHED_TOOLS
* Attach key → entry of every `open_as:'attach'` tool registered on a caller
* (from just before its first attach until its teardown). Entry shape:
*   {
*     instance          : Object        — the built tool instance
*     tokens            : string[]      — event_manager tokens owned by core
*     caller            : Object        — the caller instance the tool decorates
*     tool_name         : string
*     state             : 'loading' | 'attached' | 'closing'
*                         (only 'attached' answers is_tool_attached)
*     surface_attached  : boolean       — the tool's UI is currently on the caller
*                         (attach() succeeded and no detach() since)
*     closing_promise   : Promise|null  — the running teardown, shared by every requester
*     queue             : Promise       — serialises every attach/detach of the entry
*     reattach_pending  : boolean       — a re-attach is queued and has not started yet
*   }
*/
const attached_tools = new Map()



/**
* GET_ATTACH_KEY
* The ONE spelling of an attach key: tool name + the caller's instance `id`.
* Keyed on the LIVE caller instance, not on (id_base, lang) as view_modal is:
*   - two live instances of the same component (an edit view and a hover window)
*     share id_base + lang, and must attach independently;
*   - rebuild_component_in_lang (common.js) mutates `caller.lang` in place, so a
*     lang-based key would go stale on an attached tool.
* `caller.id` is unique per instance and set once at init.
* @param {string} tool_name - Tool name, e.g. 'tool_uca_maps'
* @param {Object} caller - Caller instance
* @returns {string}
*/
const get_attach_key = (tool_name, caller) => `${tool_name}__${caller.id}`



/**
* IS_TOOL_ATTACHED
* Whether an `open_as:'attach'` tool is currently attached to the given caller
* instance. A tool still loading, or whose teardown already started, counts as
* NOT attached (its button must read released at once, not after the async detach).
* Used by ui.tool.build_component_tool_button so a re-rendered button keeps its
* pressed state.
* @param {string} tool_name - Tool name, e.g. 'tool_uca_maps'
* @param {Object} caller - Caller instance (component/section)
* @returns {boolean}
*/
export const is_tool_attached = (tool_name, caller) => {

	if (!tool_name || !caller) {
		return false
	}

	const entry = attached_tools.get( get_attach_key(tool_name, caller) )

	return !!entry && entry.state==='attached'
}//end is_tool_attached



/**
* GET_CALLER_TOOL_BUTTONS
* The tool buttons of `tool_name` currently inside the caller's node
* (`[data-tool="<name>"].button.tool`). Empty when the caller has no node yet
* (not rendered) or any more (destroyed).
* @param {Object} caller - Caller instance
* @param {string} tool_name - Tool name
* @returns {HTMLElement[]}
*/
const get_caller_tool_buttons = (caller, tool_name) => {

	const node = caller?.node
	if (!node || typeof node.querySelectorAll!=='function') {
		return []
	}

	return [...node.querySelectorAll(`[data-tool="${CSS.escape(tool_name)}"].button.tool`)]
}//end get_caller_tool_buttons



/**
* SET_ATTACH_LOADING_MARKER
* Marks (or unmarks) the caller's buttons of this tool as busy:
* `aria-busy="true"` + class `loading` (styled in buttons.less).
* @param {Object} caller - Caller instance
* @param {string} tool_name - Tool name
* @param {boolean} loading - true to set the marker, false to remove it
* @returns {void}
*/
const set_attach_loading_marker = (caller, tool_name, loading) => {

	const buttons = get_caller_tool_buttons(caller, tool_name)
	for (const button of buttons) {
		if (loading===true) {
			button.setAttribute('aria-busy', 'true')
			button.classList.add('loading')
		}else{
			button.removeAttribute('aria-busy')
			button.classList.remove('loading')
		}
	}
}//end set_attach_loading_marker



/**
* SET_ATTACHED_MARKER
* Reflects the attached state on the caller's current node:
*   - every button of this tool gets `aria-pressed` "true" / "false"
*   - `caller.node[data-tools-attached]` holds the space-separated names of the
*     attached tools (so `[data-tools-attached~="tool_x"]` matches); a name is
*     removed on detach and the attribute dropped when it becomes empty.
* Safe to call with no caller node (nothing to mark).
* @param {Object} caller - Caller instance
* @param {string} tool_name - Tool name
* @param {boolean} attached - true when the tool is attached
* @returns {void}
*/
const set_attached_marker = (caller, tool_name, attached) => {

	// buttons
		const buttons = get_caller_tool_buttons(caller, tool_name)
		for (const button of buttons) {
			button.setAttribute('aria-pressed', attached===true ? 'true' : 'false')
		}

	// caller node attribute (token list)
		const node = caller?.node
		if (!node || typeof node.getAttribute!=='function') {
			return
		}
		const names = new Set(
			(node.getAttribute('data-tools-attached') || '').split(/\s+/).filter(Boolean)
		)
		if (attached===true) {
			names.add(tool_name)
		}else{
			names.delete(tool_name)
		}
		if (names.size > 0) {
			node.setAttribute('data-tools-attached', [...names].join(' '))
		}else{
			node.removeAttribute('data-tools-attached')
		}
}//end set_attached_marker



/**
* REPORT_ATTACH_FAILURE
* Surfaces an attach-mode failure ONCE through the client's standard error path
* (error_dispatch.handle_api_error → policy table → toast for `client.*`).
*   - An ApiError that came out of a request (source 'envelope' / 'transport')
*     was already published as 'api_error' by data_manager, which the page hands
*     to the same policy: dispatching it again would show it twice, so it is only
*     logged here.
*   - Anything else (a throw in the tool's own attach/build code, a missing
*     contract method, a falsy attach) is the client's own failure and is typed
*     `client.render_failed` (`details.reason:'tool_attach'`): the thing the user
*     asked for could not be built.
* @param {string} tool_name - Tool name
* @param {Object} caller - Caller instance
* @param {*} error - The failure (Error, ApiError or any thrown value)
* @returns {void}
*/
const report_attach_failure = (tool_name, caller, error) => {

	console.error(`view_attach: tool '${tool_name}' could not be attached to ${caller?.model} (${caller?.tipo}):`, error);

	// already dispatched by the transport (data_manager published 'api_error')
		if (is_api_error(error) && (error.source==='envelope' || error.source==='transport')) {
			return
		}

	const api_error = is_api_error(error)
		? error
		: new ApiError({
			code	: CLIENT_ERROR.RENDER_FAILED,
			details	: {reason: 'tool_attach'},
			source	: 'client',
			raw		: error
		  })

	handle_api_error(api_error)
	.catch(err => {
		console.error('view_attach: handle_api_error failed:', err)
	})
}//end report_attach_failure



/**
* ASSERT_ATTACH_CONTRACT
* An attach-mode tool must implement BOTH `attach()` and `detach()`: core cannot
* release a surface the tool cannot remove, so a half contract is a failure,
* not a degraded mode.
* @param {Object} instance - Tool instance
* @returns {void}
* @throws {Error} naming the missing method(s)
*/
const assert_attach_contract = (instance) => {

	const missing = ['attach', 'detach'].filter(name => typeof instance?.[name]!=='function')
	if (missing.length > 0) {
		throw new Error(`Invalid attach tool '${instance?.model}': missing method(s) ${missing.join(', ')}`)
	}
}//end assert_attach_contract



/**
* ENQUEUE
* Runs `task` after every attach/detach already queued on the entry, so no two
* of them ever overlap. A failed task never blocks the ones after it.
* @param {Object} entry - attached_tools entry
* @param {Function} task - async () => *
* @returns {Promise<*>} the task's own result (rejects when the task throws)
*/
const enqueue = (entry, task) => {

	const run = entry.queue.catch(() => {}).then(task)
	entry.queue = run.catch(() => {})

	return run
}//end enqueue



/**
* DETACH_SURFACE
* `detach()` the tool's UI from the caller when it is on it (idempotent: a second
* call, or a call after a failed attach, does nothing). Run inside the queue.
* @param {Object} entry - attached_tools entry
* @returns {Promise<void>}
*/
const detach_surface = async (entry) => {

	if (entry.surface_attached!==true) {
		return
	}
	entry.surface_attached = false
	await entry.instance.detach()
}//end detach_surface



/**
* ATTACH_SURFACE
* (Re-)attach the tool's UI onto the caller's CURRENT node: detach first when it
* is still on (a plain re-render, no destroy event before it), then `attach()`
* and re-apply the attached markers. Run inside the queue.
* @param {Object} entry - attached_tools entry
* @returns {Promise<void>}
* @throws {Error} when attach() throws or resolves falsy
*/
const attach_surface = async (entry) => {

	await detach_surface(entry)
	if (entry.state==='closing') {
		return
	}

	const attached = await entry.instance.attach()
	if (!attached) {
		throw new Error(`Tool '${entry.tool_name}' attach() returned a falsy value`)
	}
	entry.surface_attached = true
}//end attach_surface



/**
* TEARDOWN_ATTACHED_TOOL
* Removes an attached tool from its caller and releases it:
*   1. marks the entry closing (is_tool_attached → false at once) and unsubscribes
*      the lifecycle tokens, so nothing else is scheduled;
*   2. queued after any running attach/detach: `detach()` when the UI is on the
*      caller (the tool tolerates an already-gone surface), then
*      `instance.destroy(true, true, true)`;
*   3. drops the entry and clears the markers on the caller's current node.
* Idempotent: concurrent requesters (toggle click + caller destroy) share the
* one running teardown.
* (!) Never await this from INSIDE a queued task of the same entry: it queues
* behind that task and would wait on itself.
* @param {string} open_key - Attach key
* @param {Object} entry - attached_tools entry
* @returns {Promise<void>}
*/
const teardown_attached_tool = (open_key, entry) => {

	if (entry.closing_promise) {
		return entry.closing_promise
	}
	entry.state = 'closing'

	// stop listening first: a render/destroy during the teardown must not
	// schedule anything else
		for (const token of entry.tokens) {
			event_manager.unsubscribe(token)
		}
		entry.tokens.length = 0

	entry.closing_promise = enqueue(entry, async () => {

		// detach (the tool removes everything it added)
			try {
				await detach_surface(entry)
			} catch (error) {
				console.error(`view_attach: '${entry.tool_name}' detach failed:`, error);
			}

		// destroy the tool instance
			try {
				await entry.instance.destroy(true, true, true)
			} catch (error) {
				console.error(`view_attach: '${entry.tool_name}' destroy failed:`, error);
			}

		// unregister + markers
			if (attached_tools.get(open_key)===entry) {
				attached_tools.delete(open_key)
			}
			set_attach_loading_marker(entry.caller, entry.tool_name, false)
			set_attached_marker(entry.caller, entry.tool_name, false)
	})

	return entry.closing_promise
}//end teardown_attached_tool



/**
* SCHEDULE_REATTACH
* Re-attaches the tool after its caller rendered (`render_<caller.id>`): the
* caller replaced its node, so whatever the tool hung on the old node is gone.
* attach_surface (detach when still on, then attach onto the new node), then the
* markers on the new node.
* Serialised on the entry's queue: a render during the FIRST attach runs after it
* (so the tool ends on the new node), overlapping renders never run two
* re-attaches at once, and renders arriving while one is still QUEUED coalesce
* into it (it reads the caller's node when it runs, i.e. the latest).
* A failed re-attach is surfaced once and the tool is torn down (released, not
* left half-attached).
* @param {string} open_key - Attach key
* @param {Object} entry - attached_tools entry
* @returns {void}
*/
const schedule_reattach = (open_key, entry) => {

	if (entry.state==='closing' || entry.reattach_pending===true) {
		return
	}
	entry.reattach_pending = true

	enqueue(entry, async () => {

		entry.reattach_pending = false
		// only an attached tool re-attaches (a failed first attach, a teardown)
		if (entry.state!=='attached') {
			return
		}

		try {
			await attach_surface(entry)
			if (entry.state==='attached') {
				set_attached_marker(entry.caller, entry.tool_name, true)
			}
		} catch (error) {
			report_attach_failure(entry.tool_name, entry.caller, error)
			// (!) not awaited: the teardown queues behind this very task
			teardown_attached_tool(open_key, entry)
		}
	})
}//end schedule_reattach



/**
* ON_CALLER_DESTROY
* `destroy_<caller.id>`: the caller's surface is going away. Published by a real
* destroy AND by every refresh (common.refresh runs destroy(delete_self=false)
* before rebuilding), and a refresh whose build fails publishes no render after
* it. So: always detach at once (queued) — the UI never stays on a dead surface —
* and destroy the tool only when the caller itself is destroyed. A following
* render re-attaches (schedule_reattach).
* @param {string} open_key - Attach key
* @param {Object} entry - attached_tools entry
* @returns {void}
*/
const on_caller_destroy = (open_key, entry) => {

	if (entry.caller.status==='destroyed') {
		teardown_attached_tool(open_key, entry)
		return
	}

	enqueue(entry, () => detach_surface(entry))
	.catch(error => {
		console.error(`view_attach: '${entry.tool_name}' detach on caller destroy failed:`, error);
	})
}//end on_caller_destroy



/**
* VIEW_ATTACH
* Opens an `open_as:'attach'` tool: no modal, no window — the tool is built
* straight onto its live caller (e.g. a toolbar on a component's map), which
* avoids the empty-modal flash such tools caused under view_modal.
*
* Tool contract (checked after build, before the first attach):
*   - `attach()`  async; puts the tool's UI onto `self.caller`; resolves truthy on
*                 success; MUST be safe to call again (core calls it after every
*                 caller render).
*   - `detach()`  async; removes everything `attach()` added; tolerates an
*                 already-gone surface (the caller's node may have been replaced).
*   - `render()` is NOT called.
*
* Keys: the attach key is tool name + `caller.id` (get_attach_key) — per live
* caller instance. The tool instance's `id_variant` is `caller.id` too: with
* view_modal's `caller.id_base`, two live callers sharing id_base + lang (edit
* view + hover window) resolved to ONE tool instance in the instances map.
*
* Flow:
*   1. toggle — the tool is attached to this caller: tear it down (detach +
*      destroy + unsubscribe + unregister + markers) and resolve false.
*   2. guard — the same key is loading (or tearing down): refuse synchronously
*      (false), so repeated clicks never start a second attach.
*   3. load — `get_instance` + `load_style(tool_css_url(model))` in parallel,
*      `build(true)`, contract check. Buttons carry the loading marker meanwhile.
*   4. register + subscribe BEFORE the first attach (so a caller render during it
*      is not missed — the queue runs the re-attach after it):
*        `render_<caller.id>`  → schedule_reattach
*        `destroy_<caller.id>` → on_caller_destroy (detach always; teardown when
*                                the caller is really destroyed)
*   5. first attach (queued), then the attached markers.
*
* Failure (load, build, missing attach/detach, attach throws or is falsy): the
* instance is destroyed, keys and subscriptions dropped, button markers reset, the
* error surfaced once (report_attach_failure) and the promise resolves false.
*
* @param {Object} options
* @param {Object} options.tool_context - Full tool context object
* @param {Object} options.caller - Live caller instance; required
* @param {Object|null} [options.caller_options] - Extra data forwarded to the tool
* @returns {Promise<Object|boolean>} The attached tool instance; false on toggle-off,
*   refusal (already loading) or failure
*/
const view_attach = async function(options) {

	// options
		const caller = options.caller

	// validate caller
		if (!caller) {
			console.error('view_attach: missing caller');
			return false
		}

	// tool context (clone to avoid mutating the passed-in object)
	// Same merge as view_modal, except id_variant: the caller INSTANCE id, so two
	// live callers sharing id_base + lang get two tool instances (see header).
		const tool_context = Object.assign({}, options.tool_context || {}, {
			lang		: caller.lang,
			type		: 'tool',
			id_variant	: caller.id // one tool instance per live caller
		})
		const tool_name = tool_context.name

	// instance options
		const instance_options = Object.assign({
			caller			: caller,
			caller_options	: options.caller_options || null
		}, tool_context)

	// open_key (per live caller instance)
		const open_key = get_attach_key(tool_name, caller)

	// loading guard (synchronous: before any await)
		if (attaching_tool_keys.has(open_key)) {
			return false
		}

	// toggle. Attached (or tearing down): release it
		const attached_entry = attached_tools.get(open_key)
		if (attached_entry) {
			if (attached_entry.state==='attached') {
				// markers flip at once; the async teardown follows
				set_attached_marker(caller, tool_name, false)
				await teardown_attached_tool(open_key, attached_entry)
			}
			return false
		}

		attaching_tool_keys.add(open_key)
		set_attach_loading_marker(caller, tool_name, true)

	// fail. Clean up everything a failed open left and surface the error once
		let tool_instance	= null
		let entry			= null
		const fail = async (error) => {
			if (entry) {
				entry.state = 'closing'
				for (const token of entry.tokens) {
					event_manager.unsubscribe(token)
				}
				entry.tokens.length = 0
				if (attached_tools.get(open_key)===entry) {
					attached_tools.delete(open_key)
				}
			}
			if (tool_instance) {
				try {
					await tool_instance.destroy(true, true, true)
				} catch (destroy_error) {
					console.error(`view_attach: '${tool_name}' destroy after failure failed:`, destroy_error);
				}
			}
			attaching_tool_keys.delete(open_key)
			set_attach_loading_marker(caller, tool_name, false)
			set_attached_marker(caller, tool_name, false)

			report_attach_failure(tool_name, caller, error)

			return false
		}

	// load + build + contract
		try {

			// instance + tool CSS in parallel (tool_css_url, exactly as build() does,
			// so the two loads dedup to one request — see view_modal)
				const css_url = tool_context.model
					? tool_css_url(tool_context.model)
					: tool_context.css?.url
				const [instance] = await Promise.all([
					get_instance(instance_options),
					css_url ? load_style(css_url) : null
				])

			if (!instance) {
				throw new Error(`Tool instance '${tool_name}' could not be created`)
			}

			// already running elsewhere (e.g. opened through another path): not ours
			// to attach nor to destroy
				if (instance.status && instance.status!=='initialized') {
					console.warn(`view_attach: tool '${tool_name}' is already running for this caller (status: ${instance.status}); not attached.`);
					attaching_tool_keys.delete(open_key)
					set_attach_loading_marker(caller, tool_name, false)
					return false
				}

			tool_instance = instance

			// build
				await tool_instance.build(true)
				if (typeof tool_instance.error!=='undefined') {
					throw new Error(`Tool '${tool_name}' build failed: ${tool_instance.error}`)
				}

			// contract
				assert_attach_contract(tool_instance)

		} catch (error) {
			return fail(error)
		}

	// register + lifecycle subscriptions, BEFORE the first attach
		entry = {
			instance			: tool_instance,
			tokens				: [],
			caller				: caller,
			tool_name			: tool_name,
			state				: 'loading',
			surface_attached	: false,
			closing_promise		: null,
			queue				: Promise.resolve(),
			reattach_pending	: false
		}
		attached_tools.set(open_key, entry)
		const current_entry = entry
		// caller rendered: its node was replaced → re-attach onto the new one
		entry.tokens.push(
			event_manager.subscribe('render_' + caller.id, () => {
				schedule_reattach(open_key, current_entry)
			})
		)
		// caller surface going away (destroy or refresh)
		entry.tokens.push(
			event_manager.subscribe('destroy_' + caller.id, () => {
				on_caller_destroy(open_key, current_entry)
			})
		)

	// first attach (queued: a render arriving meanwhile re-attaches after it).
	// The state flips INSIDE the task, so a re-attach queued behind it sees an
	// attached tool.
		try {
			await enqueue(entry, async () => {
				await attach_surface(current_entry)
				if (current_entry.state==='loading') {
					current_entry.state = 'attached'
				}
			})
		} catch (error) {
			return fail(error)
		}

	// loaded
		attaching_tool_keys.delete(open_key)
		set_attach_loading_marker(caller, tool_name, false)

	// caller destroyed while the tool was loading: its destroy event found the
	// entry still loading — release the tool now
		if (caller.status==='destroyed' || entry.state==='closing') {
			await teardown_attached_tool(open_key, entry) // joins a running teardown
			return false
		}

	// attached
		set_attached_marker(caller, tool_name, true)


	return tool_instance
}//end view_attach



/**
* VIEW_WINDOW
* Opens the tool in a new browser window or tab.
*
* All state needed to reconstruct the caller in the new window is serialised into
* a `raw_data` URL parameter as LZString-compressed JSON:
*   { caller_ddo: {...}, tool_config: {...}, caller_options: {...} }
* The new window's `tool_common.init()` decompresses this and rebuilds the caller
* via `get_instance`.  No JS object references cross the window boundary.
*
* For `component_dataframe` callers, the dataframe row context
* (`section_id_key`, `section_tipo_key`, `main_component_tipo`) is serialised inside
* `caller_ddo.caller_dataframe` so the reconstructed tool can identify the correct row.
*
* `windowFeatures` format:
*   - Object: `{left, top, width, height}` (plus the `popup` / `noopener` /
*     `noreferrer` flags). A value is a number, or the relative form
*     `"return screen.width - 760"` — PARSED by `parse_window_features`
*     (window_features.js), never evaluated; it reads a closed list of
*     `screen.*` / `window.*` dimensions, plus or minus an integer.
*   - String: the same pairs inline ('left=100,top=100,…'), same grammar.
*   - null: `open_window` falls back to 'new_tab'.
*   Anything outside the grammar throws, naming the key.
*
* After the popup opens, a one-shot `focus` listener on the parent window fires
* when the user returns (popup closed or alt-tabbed back) and refreshes the caller
* to pick up any changes made in the tool window.  The 'blur' event is intentionally
* NOT used because tool_upload triggers a blur when opening the native file-picker.
*
* URL length guard: URLs above 3 000 characters are flagged with a console warning
* (some proxy/browser combinations silently truncate long URLs).
*
* @param {Object} options - Window view options
* @param {Object} options.tool_context - Full tool context object; `name` and
*   `tool_config` are extracted to build the URL and the serialised payload
* @param {Object} options.caller - Live caller instance; required for caller_ddo
*   serialisation and post-close refresh
* @param {Object|null} [options.caller_options=null] - Arbitrary extra data for the tool,
*   included verbatim in the serialised payload and surfaced as `self.caller_options`
*   in the new window's init()
* @param {string|Object|null} [options.windowFeatures=null] - Native `window.open`
*   features string, or an object whose values may be Function-as-strings (evaluated
*   at open time for screen-relative arithmetic); null opens in a new tab
* @returns {Promise<Window|null>} The opened Window object, or null if the browser
*   blocked the popup or the caller was missing
*/
const view_window = async function(options) {

	// options
		const tool_context		= options.tool_context
		const caller			= options.caller
		const caller_options	= options.caller_options || null
		// const open_as		= options.open_as
		const windowFeatures	= options.windowFeatures || null

	// caller guard
		if (!caller) {
			console.error('view_window: caller is required');
			return null;
		}
		// windowFeatures sample:
			// {
			// 	left	: 'return screen.width -760',
			// 	top		: 0,
			// 	width	: 760,
			// 	height	: 500
			// }

	// short vars
		const name			= tool_context.name
		const tool_config	= tool_context.tool_config || null

	// fix current instance as caller in global window to be accessible from new window
		// window.callers = window.callers || {}
		// window.callers[caller.id] = caller

	// caller_ddo. Minimum caller data to re-build it from tool
	// Only serialise scalar properties (no DOM refs, no circular objects); the new
	// window will call get_instance(caller_ddo) to reconstruct a live instance.
		const caller_ddo = {
			id_variant			: caller.id_variant || null,
			tipo				: caller.tipo,
			section_tipo		: caller.section_tipo,
			section_id			: caller.section_id,
			section_id_selected	: caller.section_id_selected,
			mode				: caller.mode,
			model				: caller.model,
			lang				: caller.lang,
			label				: caller.label
		}

	// caller_dataframe . Used for dataframe
	// component_dataframe callers need extra row-context so the tool in the new
	// window can identify which dataframe row it is acting on.
		if(caller.model==='component_dataframe'){
			caller_ddo.caller_dataframe = {
				section_tipo		: caller.section_tipo,
				section_id			: caller.section_id,
				section_id_key		: caller.data.section_id_key,
				section_tipo_key	: caller.data.section_tipo_key,
				main_component_tipo	: caller.tipo
			}
		}

	// URL
		// raw_data will be compressed and de-compressed from target window
		// The full payload is JSON-stringified then LZString-compressed to stay
		// within URL-length limits.  The new window decompresses it in init().
		// Lazy (CONVENTIONS.md §2, rationale 3): see the decompress site in init().
		// The windowFeatures grammar rides the same wait (see load_window_features).
		const [{ LZString: lzstring }, window_features] = await Promise.all([
			import('/dedalo/lib/lz-string/lz-string.js'),
			windowFeatures ? load_window_features() : null
		])
		const raw_data = lzstring.compressToEncodedURIComponent(
			JSON.stringify({
				caller_ddo		: caller_ddo,
				tool_config		: tool_config,
				caller_options	: caller_options
			})
		)
		const url = DEDALO_CORE_URL + `/page/?tool=${name}&menu=false&raw_data=` + raw_data
		if (url.length>3000) {
			console.warn('Warning. The URL is too long:', url.length);
		}

	// window features
	// The windowFeatures value → the comma-separated string window.open() expects.
	// PARSED against a closed grammar (window_features.js), never evaluated: a
	// number, or the legacy relative form 'return screen.width -760'. Anything
	// else throws naming the key (WC-2026-11-19-window-features-grammar).
		const parsed_windowFeatures = window_features
			? window_features.parse_window_features(windowFeatures)
			: null

	// tool_window
	// Open the tool in a named window so repeated opens reuse the same tab/window
	// rather than spawning a new one each time.
		const window_name	= name +'_'+ (caller.id_base || '')
		const tool_window	= open_window({
			url			: url,
			target		: window_name,
			features	: parsed_windowFeatures || 'new_tab'
		})
		if (!tool_window) {
			console.error('view_window: popup blocked or failed to open');
		}
		// this window focus event (not use blur because tool_upload blurs on open file window)
		// One-shot focus handler: fires when the user returns to the parent window
		// (e.g. after closing the tool window) and triggers a caller refresh.
		const fn_refresh_caller = function() {
			window.removeEventListener('focus', fn_refresh_caller)
			// refresh caller
			// Note that in some situations, caller is not an instance like in grid_dd indexation button
				if (caller && typeof caller.refresh==='function') {
					// List-mode callers need a full re-render to reflect row changes;
					// non-list callers only need a content refresh.
					const render_level = (caller.mode==='list')
						? 'full'
						: 'content'
					caller.refresh({
						refresh_id_base_lang	: true,
						render_level			: render_level
					})
				}
		}
		window.addEventListener('focus', fn_refresh_caller)


	return tool_window
}//end view_window



/**
* GET_TOOL_LABEL
* Label resolver bound as `self.get_tool_label` on every tool instance. Looks up
* `label_name` in `this.context.labels` — the label array of the tool's registered
* context — and returns its value.
*
* SERVING CONTRACT: `context.labels` is already localised. The server
* (buildToolElementContext, src/core/tools/registry.ts) emits ONLY the entries
* whose `lang` equals the request's application lang, and an EMPTY array when the
* tool has no label in that lang — PHP behaved identically (frozen in
* test/parity/fixtures/oracle_harvest/tool_element_context_differential.json) and
* test/unit/tool_context_labels_lang.test.ts gates it. So there is nothing here to
* choose between languages: a name match IS the right language, and a miss means
* the label is untranslated for this lang, which the call site handles with its
* own `|| 'literal'` fallback.
*
* (This replaced a three-tier current-lang / install-default / any-lang priority
* chain. With a single-lang payload the second and third tiers were unreachable,
* so the chain only implied a fallback the wire could never deliver.)
*
* If the resolved label value contains `%s` placeholders, the variadic `...rest`
* arguments are interpolated via `printf`.
*
* Assigned to `self.get_tool_label` during `init()`, so `this` is the tool instance.
* Exported only so a client gate can drive the REAL resolver (printf `%s` forwarding)
* with `get_tool_label.call({context:{labels}}, …)`; tools call it through `self`.
*
* @param {string} label_name - Key matching `label.name` in `this.context.labels`,
*   e.g. 'indexation_tool' or 'save_button'
* @param {...string} rest - Additional positional arguments passed to `printf` for
*   `%s` placeholder substitution in the resolved label value
* @returns {string|null} The (printf-interpolated) label string, or null when no
*   entry for `label_name` is found or `this.context.labels` is absent
*/
export const get_tool_label = function(label_name, ...rest) {

	const tool_labels = this.context?.labels
	if (!tool_labels) {
		return null
	}

	const found = tool_labels.find(el => el.name === label_name)

	return found
		? printf(found.value, ...rest)
		: null
}//end get_tool_label



// @license-end
