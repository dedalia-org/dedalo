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
*       be visualised (modal vs. new window) and hands off to `view_modal` /
*       `view_window`.
*   - `load_component` — utility to asynchronously instantiate and build a component
*       inside a tool, managing the tool's `ar_instances` registry.
*   - `get_tool_label` (private) — label resolver bound to `this.context.labels`
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
*   load_component — component loader for use inside tool render code
*/



// imports
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {response_data} from '../../../core/common/js/api_error.js'
	import {
		clone,
		dd_console,
		printf,
		open_window,
		load_style,
		tool_base_url
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
		const tool_css_url = tool_base_url(self.model) + '/css/' + self.model + '.css' + `?v=${page_globals.dedalo_version}`
		await load_style(tool_css_url)

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
* tool_request` RQO that every tool previously assembled by hand.  Routes the
* call to the static PHP method `{this.model}::{action}(object $options)` on
* the server.
*
* Security contract: the target PHP method MUST be listed in the tool class's
* `API_ACTIONS` constant (an associative map of action → handler).  Unlisted
* methods are rejected server-side by `tool_security`.
*
* Background mode: when `options.background = true`, the flag
* `background_running: true` is injected into the options object forwarded to
* the PHP method.  The PHP side must also list the method in
* `BACKGROUND_RUNNABLE`; the server queues the job via the CLI runner and
* returns immediately with a job handle.
*
* `prevent_lock` (default true) releases the PHP session write-lock before the
* request body is processed.  Set to false only when the action needs to write
* session data (rare).
*
* @param {Object} options - Request options
* @param {string} options.action - PHP static method name to invoke, e.g. 'my_action'
* @param {Object} [options.options={}] - Options object forwarded verbatim to the PHP method
* @param {boolean} [options.background=false] - When true, queues the action on the
*   server background runner; caller receives a job handle, not a direct result
* @param {string|null} [options.url=null] - Optional API endpoint URL override; when
*   null, uses the default data_manager endpoint
* @param {boolean} [options.prevent_lock=true] - When true, releases the PHP session
*   write-lock before handling the request (recommended for read-heavy actions)
* @returns {Promise<Object>} API response object `{ result, msg, errors }`
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
	// inside source so the PHP dispatcher can route to the correct method.
		const rqo = {
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: prevent_lock,
			source			: create_source(self, action),
			options			: background===true
				? {...fn_options, background_running: true}
				: fn_options
		}

	// request
		const api_response = await data_manager.request({
			body : rqo,
			...(url ? {url} : {})
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
* visualisation mode.  Inits, builds, and renders the requested tool, dispatching
* to `view_window` or `view_modal` based on `open_as`.
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
*   'window' | 'modal' | 'tab' | 'popup'; when null, falls back to
*   `tool_context.properties.open_as` or 'modal'
* @param {string|Object|null} [options.windowFeatures=null] - Browser window-features
*   string ('left=100,top=100,width=320,height=320') or object
*   ({ left: 100, top: 0, width: 760, height: 500 }); overrides the context value
* @returns {Promise<Object|boolean>} The tool instance (modal path) or the new Window
*   object (window path); false on validation failure or missing context
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
		// open_as. Mode of tool visualization: modal, tab, popup
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

	// open tool visualization
	// 'window' is the only open_as value that uses a separate browser window;
	// all other values ('modal', 'tab', 'popup') go through view_modal.
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
			open_as			: open_as, // string like 'tab' | 'popup'
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
*
* @param {Object} options - Modal view options
* @param {Object} options.tool_context - Full tool context object (name, model, css,
*   icon, label, properties, …) — used to construct the instance options and UI
* @param {Object} options.caller - Live caller instance; required (guards early exit)
* @param {Object|null} [options.caller_options] - Extra data forwarded to the tool
* @param {string} [options.open_as] - Sub-mode hint forwarded verbatim (e.g. 'tab',
*   'popup'); currently informational only — modal rendering does not differ by sub-mode
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

	// tool_instance. Resolved inside the modal spinner callback (see below), so the
	// modal opens on the click and the slow part (tool ES module import, CSS, build)
	// runs behind the spinner instead of before anything is painted.
		let tool_instance = null
		let modal_closed = false // set by modal.on_close

	// load_tool_instance. Instance load / recover + tool CSS.
		const load_tool_instance = async () => {

			const instance = await get_instance(instance_options)

			// already running elsewhere (status other than 'initialized'): toggle-close
			if (instance && instance.status && instance.status!=='initialized') {
				return {instance, already_open : true}
			}

			// load tool CSS
			// Await to prevent a first paint of the tool before its stylesheet is
			// applied (build() awaits its own load_style the same way).
			// (!) Build the versioned URL exactly as build() does so the two loads
			// dedup to a single request — the server css.url is unversioned, and
			// load_style keys on the exact string, so a bare url would fetch twice.
			const tool_css_url = tool_context.model
				? tool_base_url(tool_context.model) + '/css/' + tool_context.model + '.css' + `?v=${page_globals.dedalo_version}`
				: tool_context.css?.url
			if(tool_css_url) {
				await load_style(tool_css_url)
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
		if (windowFeatures && typeof windowFeatures==='object') {
			for (let [key, value] of Object.entries(windowFeatures)) {
				modal.modal_content.style[key] = value
			}
		}


	return view_promise
}//end view_modal



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
*   - String: forwarded verbatim to `window.open` (e.g. 'left=100,top=100,…').
*   - Object: each value may itself be a Function-as-string starting with 'return'
*     (e.g. `"return screen.width - 760"`) — these are evaluated via `new Function(…)()`
*     at open time so callers can express screen-relative positions declaratively.
*     @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function
*   - null: `open_window` falls back to 'new_tab'.
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
		const { LZString: lzstring } = await import('/dedalo/lib/lz-string/lz-string.js')
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
	// Normalise the windowFeatures value into the comma-separated string that
	// window.open() expects, evaluating any Function-as-string values first.
		const parsed_windowFeatures = typeof windowFeatures==='string'
			? windowFeatures // string case as 'left=100,top=100,width=320,height=320'
			: (windowFeatures && typeof windowFeatures==='object')
				? (()=>{ // object case as {"left":"return screen.width -760","top":0,"width":760,"height":500}

					const parsed_pairs = []
					for(const key in windowFeatures) {

						// value could be a Function as string like 'return screen.width -500'
						// @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function
						const value = typeof windowFeatures[key]==='string' && windowFeatures[key].indexOf('return')===0
							? Function(windowFeatures[key])() // parse and auto exec the created Function
							: windowFeatures[key]

						const pair = `${key}=${value}`

						parsed_pairs.push(pair)
					}

					const parsed_string = parsed_pairs.join(',')

					return parsed_string
				  })()
				: null // null or non-object case

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
* This function is NOT exported — it is only assigned to `self.get_tool_label`
* during `init()`, so `this` is always the tool instance.
*
* @param {string} label_name - Key matching `label.name` in `this.context.labels`,
*   e.g. 'indexation_tool' or 'save_button'
* @param {...string} rest - Additional positional arguments passed to `printf` for
*   `%s` placeholder substitution in the resolved label value
* @returns {string|null} The (printf-interpolated) label string, or null when no
*   entry for `label_name` is found or `this.context.labels` is absent
*/
const get_tool_label = function(label_name, ...rest) {

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
