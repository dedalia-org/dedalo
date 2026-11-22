// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// import needed modules
	import {dd_console} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {response_data} from '../../../core/common/js/api_error.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_update_cache} from './render_tool_update_cache.js' // self tool rendered (called from render common)



/**
* TOOL_UPDATE_CACHE
* Dédalo operator tool for bulk-regenerating the stored/cached data of one or
* more components across an entire section.
*
* Responsibilities:
*  - Fetches the caller section's full component tree from the server via
*    `get_component_list` (which enriches each component with its available
*    `regenerate_options`, e.g. "delete_normalized_files" for media components).
*  - Tracks operator selections: which component tipos to regenerate
*    (`selected_tipos`) and any per-component regeneration flags
*    (`regenerate_options`).
*  - Dispatches the update via `update_cache()`, which issues a single
*    background API request (`background_running: true`) so the PHP process
*    runs independently of the browser session.
*  - Delegates DOM rendering entirely to `render_tool_update_cache.prototype.edit`
*    (wired below as `tool_update_cache.prototype.edit`).
*
* Lifecycle (same as every Dédalo tool):
*   1. `init(options)`  — inherited from `tool_common`; seeds all well-known
*        tool properties and resolves the caller instance.
*   2. `build(autoload)` — calls `tool_common.prototype.build` then populates
*        `self.components_list` via a server round-trip.
*   3. `render(options)` — inherited from `tool_common`; invokes `self.edit()`.
*
* Server-side counterpart: tools/tool_update_cache/class.tool_update_cache.php
*   API_ACTIONS:          ['update_cache', 'get_component_list']
*   BACKGROUND_RUNNABLE:  ['update_cache']  (forked via process_runner.php)
*
* Exports:
*   tool_update_cache — constructor; the prototype chain provides init, build,
*     get_components_list, update_cache, render, destroy, refresh, and edit.
*/
export const tool_update_cache = function () {

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
	this.caller			= null

	// selected_tipos: array of selected tipos as ['rsc187','rsc185'..]
	this.selected_tipos		= []
	// regenerate_options: user selected regenerate_options as {'rsc178':{"delete_normalized_files":true}}
	this.regenerate_options	= {}

	// full list of components context from API tool call
	this.components_list = []

	return true
}//end tool_update_cache



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	tool_update_cache.prototype.render	= tool_common.prototype.render
	tool_update_cache.prototype.destroy	= common.prototype.destroy
	tool_update_cache.prototype.refresh	= common.prototype.refresh
	tool_update_cache.prototype.edit	= render_tool_update_cache.prototype.edit



/**
* INIT
* Custom tool init — delegates to the shared `tool_common.prototype.init` and
* returns its result unchanged.
*
* This method exists as a hook for future tool-specific initialisation that must
* run before the build phase.  Currently no extra properties are seeded here
* beyond what `tool_common.prototype.init` already provides.
*
* @param {Object} options - Initialisation options forwarded to tool_common.
* @returns {Promise<boolean>} Resolves to true when init completes successfully.
*/
tool_update_cache.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	// set the self specific vars not defined by the generic init (in tool_common)


	return common_init
}//end init



/**
* BUILD
* Custom tool build — delegates to `tool_common.prototype.build` then populates
* `self.components_list` with the caller section's full component tree.
*
* After the generic build (which loads the tool CSS and resolves ddo_map entries),
* `get_components_list()` is called to fetch the enriched component context from
* the server.  The result is stored in `self.components_list` so that the render
* phase (`edit()`) can build the checkbox list without another round-trip.
*
* @param {boolean} [autoload=false] - When true, the generic build skips
*   certain deferred setup steps (passed through to `tool_common.prototype.build`).
* @returns {Promise<boolean>} Resolves to the value returned by the generic build.
*/
tool_update_cache.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	// specific actions.. like fix main_element for convenience
		self.components_list = await self.get_components_list()


	return common_build
}//end build_custom



/**
* GET_COMPONENTS_LIST
* Fetches the caller section's full component tree from the server, enriched
* with per-component `regenerate_options`.
*
* Calls `dd_tools_api::tool_request → tool_update_cache::get_component_list()`
* (PHP).  The PHP method wraps `common::get_section_elements_context` and then
* appends each component's `regenerate_options` (returned by the static
* `get_regenerate_options()` method on the component model class, or null when
* that method is absent).
*
* Request shape (rqo):
*   {
*     dd_api  : 'dd_tools_api',
*     action  : 'tool_request',
*     source  : { … },           // tool identity built by create_source
*     options : {
*       ar_section_tipo          : [section_tipo],
*       use_real_sections        : false,
*       skip_permissions         : true,
*       ar_tipo_exclude_elements : null,
*       ar_components_exclude    : []   // empty = return all components
*     }
*   }
*
* (!) `SHOW_DEVELOPER` is referenced in the debug log below but is NOT declared
* in the global-declarations comment at the top of this file.  If the ESLint
* no-undef rule is enforced this will cause a lint error at runtime.
*
* @returns {Promise<Array>} Resolves to the `response.result` array — a flat
*   list of component context objects (model, tipo, label, regenerate_options, …),
*   ordered and grouped as returned by `get_section_elements_context`.
*/
tool_update_cache.prototype.get_components_list = async function() {

	const self = this

	const section_tipo = self.caller.section_tipo

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
		// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'get_component_list')

	// options
		const options = {
			ar_section_tipo				: [section_tipo],
			use_real_sections			: false,
			skip_permissions			: true,
			ar_tipo_exclude_elements	: null,
			ar_components_exclude		: [] // force to get all components
		}

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: options
		}

	// call to the API, fetch data and get response
		const response = await data_manager.request({
			body : rqo
		})

		if(SHOW_DEVELOPER===true) {
			dd_console("-> get_component_list API response:",'DEBUG',response);
		}

		const components_list = response_data(response) // array of objects


	return components_list
}//end get_components_list



/**
* UPDATE_CACHE
* Sends the background cache-regeneration request to the server and returns the
* raw API response as a Promise.
*
* The server forks a CLI process via `process_runner.php` (because
* `background_running: true` is set).  The response carries a `pid` / `pfile`
* pair instead of the final result.  The caller (`render_tool_update_cache`)
* uses that pair to open an SSE stream and poll `dd_utils_api::get_process_status`
* until the forked process exits.
*
* Composition of the `components_selection` array sent to the server:
*   For each tipo in `self.selected_tipos`, push:
*     { tipo: string, regenerate_options: Object|null }
*   `regenerate_options` comes from `self.regenerate_options[tipo]`, which is
*   populated by the checkbox change handlers in `render_regenerate_options`.
*   If no options were set for a tipo, `null` is passed explicitly.
*
* Request shape (rqo):
*   {
*     dd_api  : 'dd_tools_api',
*     action  : 'tool_request',
*     source  : { … },
*     options : {
*       background_running     : true,
*       section_tipo           : string,
*       components_selection   : [{ tipo, regenerate_options }, …],
*       sqo                    : the caller list's live sqo
*     }
*   (no `lang`: the server labels the run in the request's application
*   language — T2-OX7-1a)
*   }
*
* Worker config:
*   use_worker : true   — routed through a dedicated web worker in data_manager
*   retries    : 1      — only a single attempt (background job must not be
*                         dispatched twice on transient network failure)
*   timeout    : 3 600 000 ms (1 hour) — long enough for very large sections
*
* (!) `SHOW_DEVELOPER` is referenced in the debug log below but is NOT declared
* in the global-declarations comment at the top of this file.
*
* @returns {Promise<Object>} Resolves to the response envelope:
*   {
*     ok      : boolean,   // false on immediate refusal (then `error` carries the code)
*     data    : Object,    // the run payload (summary, errors, regenerated, …)
*     pid     : number,    // OS process-id of the forked CLI worker (extension key)
*     pfile   : string     // path to the process status file polled by SSE (extension key)
*   }
*/
tool_update_cache.prototype.update_cache = function() {

	const self = this

	// short vars
		const section_tipo			= self.caller.section_tipo
		const selected_tipos		= self.selected_tipos
		const regenerate_options	= self.regenerate_options

	// sqo. The caller list's LIVE scope (filter / filter_by_locators): the server
	// REQUIRES it and processes exactly the matched set (pagination is stripped
	// server-side). Deep-cloned — the caller's sqo is never handed out live.
	// Without this the request once silently swept the WHOLE section while the
	// button displayed the filtered count (WC-043).
		const caller_sqo = self.caller.rqo?.sqo
			? structuredClone(self.caller.rqo.sqo)
			: { section_tipo: [section_tipo] }

	// components_selection. Compose user components selection adding regenerate_options
		const components_selection = []
		const selected_tipos_length = selected_tipos.length
		for (let i = 0; i < selected_tipos_length; i++) {

			const tipo = selected_tipos[i]

			components_selection.push({
				tipo				: tipo,
				regenerate_options	: regenerate_options[tipo] || null
			})
		}

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'update_cache')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options : {
				background_running		: true, // set run in background CLI
				section_tipo			: section_tipo,
				components_selection	: components_selection,
				sqo						: caller_sqo
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				use_worker	: true,
				body		: rqo,
				retries : 1, // one try only
				timeout : 3600 * 1000 // 3600 secs waiting response
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> update_cache API response:",'DEBUG',response);
				}

				// const result = response.result // array of objects

				resolve(response)
			})
		})
}//end update_cache



// @license-end
