// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
 * TOOL_HIERARCHY (module)
 * Client-side controller for the Hierarchy Tool — a Dédalo section toolbar action
 * that generates a new custom ontology (virtual section) from an existing real section.
 *
 * Purpose
 * -------
 * Cultural-heritage databases in Dédalo often need per-project thesauri and hierarchy
 * trees that mirror the structure of a reference ontology section.  This tool collects
 * the configuration parameters (TLD, name, active state, typology, language, real
 * section tipo) from the user via an inline form, then fires a single server-side call
 * (`generate_virtual_section`) that creates all required ontology elements and
 * thesaurus root nodes.
 *
 * Architecture
 * ------------
 * Follows the standard tool_common lifecycle:
 *   1. `init`  — seeds all properties via `tool_common.prototype.init`.
 *   2. `build` — loads the tool's CSS and resolves ddo_map component instances
 *                via `tool_common.prototype.build`.
 *   3. `render`/`edit` — delegated to `render_tool_hierarchy.prototype.edit`,
 *                which builds the form DOM and wires the "Generate" button.
 *
 * The server action (`generate_virtual_section`) is the only API call this module
 * makes; it is routed through `dd_tools_api::tool_request` (allowlisted in
 * `class.tool_hierarchy.php::API_ACTIONS`).
 *
 * Exported symbols
 * ----------------
 * `tool_hierarchy` — the constructor; all methods are prototype-assigned below.
 */

// import needed modules
// you can import and use your own modules or any dedalo module of section, components or other tools.
// by default you will need the tool_common to init, build and render.
// use tool_common is not mandatory, but it can help to do typical task as open tool window, or load the section and components defined in ontology.
// import dd_console if you want to use dd_console with specific console.log messages
	import {dd_console} from '../../../core/common/js/utils/index.js'
// import data_manager if you want to access to Dédalo API
	import {data_manager} from '../../../core/common/js/data_manager.js'
// import common to use destroy, render, refresh and other useful methods
	import {common, create_source} from '../../../core/common/js/common.js'
// tool_common, basic methods used by all the tools
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
// specific render of the tool
	import {render_tool_hierarchy} from './render_tool_hierarchy.js' // self tool rendered (called from render common)



/**
* TOOL_HIERARCHY
* Constructor for the Hierarchy Tool instance.
*
* Declares all instance properties used across the lifecycle (init → build → render).
* The tool_common lifecycle methods populate most of these; the constructor only
* sets them to null so property shapes are visible and V8 can optimise the object.
*
* Properties
* ----------
* @var {string|null}       id           - Unique instance identifier (set by `common.prototype.init`).
* @var {string|null}       model        - Always 'tool_hierarchy'.
* @var {string|null}       mode         - Render mode; typically 'edit' for this tool.
* @var {HTMLElement|null}  node         - Root DOM node of the rendered tool.
* @var {Array|null}        ar_instances - Child component instances (form fields, etc.)
*                                         managed by this tool during its lifecycle.
* @var {Array|null}        events_tokens - Event subscription handles; cleaned up on destroy.
* @var {string|null}       status       - Current lifecycle status ('loading', 'done', …).
* @var {HTMLElement|null}  main_element - Primary interactive DOM element inside the tool.
* @var {string|null}       type         - Ontology type tag (resolved from tool context).
* @var {string|null}       source_lang  - Source language code when the tool operates in
*                                         translation mode (unused by this tool currently).
* @var {string|null}       target_lang  - Target language code (unused by this tool currently).
* @var {Array|null}        langs        - Available language codes (unused by this tool currently).
* @var {Object|null}       caller       - The component or section instance that opened this
*                                         tool; used to refresh the parent after generation.
* @var {Object|null}       rebuild_policy - The server's "Force to create" verdict
*                                         {allowed, reason} (inspect_hierarchy `rebuild`).
* @var {Object|null}       force_to_create_control - {label, checkbox} of that control,
*                                         painted by render_tool_hierarchy paint_rebuild_policy.
*/
export const tool_hierarchy = function () {

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

	this.rebuild_policy				= null
	this.force_to_create_control	= null
}//end tool_hierarchy



/**
* COMMON FUNCTIONS
* Prototype assignments that wire the standard tool_common / common lifecycle
* methods onto this constructor, then attach the concrete edit-mode renderer.
*
* render   — from tool_common: delegates to `self.edit()` (or the error view).
* destroy  — from common: tears down DOM nodes, event listeners, and ar_instances.
* refresh  — from common: re-runs init → build → render with the current options.
* edit     — from render_tool_hierarchy: builds the form DOM and the Generate button.
*/
// prototypes assign
	tool_hierarchy.prototype.render		= tool_common.prototype.render
	tool_hierarchy.prototype.destroy	= common.prototype.destroy
	tool_hierarchy.prototype.refresh	= common.prototype.refresh
	// render mode edit (default). Set the tool custom manager to build the DOM nodes view
	tool_hierarchy.prototype.edit		= render_tool_hierarchy.prototype.edit



/**
* INIT
* Seeds the tool instance with its runtime context by delegating to the generic
* `tool_common.prototype.init`.  After this call the following properties are
* populated on `this`:
*   - model, section_tipo, section_id, lang, mode
*   - caller (the originating component/section)
*   - tool_config (loaded from context or created with defaults)
*
* No additional hierarchy-specific initialisation is required; all configuration
* comes from the caller and from ontology at build time.
*
* @param {Object} options - Standard tool init options forwarded verbatim to
*                           `tool_common.prototype.init`.  Expected keys include
*                           `caller`, `mode`, `lang`, and optionally `tool_config`.
* @returns {Promise<boolean>} Resolves with the boolean result of `common_init`
*                              (true on success, false when the init aborted).
*/
tool_hierarchy.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
	// it will assign common vars as:
		// model
		// section_tipo
		// section_id
		// lang
		// mode
		// etc
	// set the caller if it was defined or create it and set the tool_config or create new one if tool_config was not defined.
		const common_init = await tool_common.prototype.init.call(this, options);


	return common_init
}//end init



/**
* BUILD
* Resolves the tool's runtime context and loads any components listed in the
* ontology `ddo_map` by delegating to `tool_common.prototype.build`.  After this
* call `self.ar_instances` is populated with the loaded component instances and
* `self.context` holds the tool's context object.
*
* No hierarchy-specific build steps are needed; the form components (hierarchy4–9,
* hierarchy109) are instantiated lazily inside `render_tool_hierarchy.edit` using
* `get_instance`, so they do not need to be declared in the `ddo_map`.
*
* To customise the `load_ddo_map` step (e.g. to load components conditionally),
* pass a second argument to `tool_common.prototype.build.call`:
*   `{ load_ddo_map: function() { … } }`
*
* @param {boolean} [autoload=false] - When true, instructs `tool_common.prototype.build`
*                                     to auto-fetch remote data for the ddo_map entries.
* @returns {Promise<boolean>} Resolves with the boolean result of `common_build`
*                              (true on success, false on error).
*/
tool_hierarchy.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
	// it will load the components or sections defined in ontology ddo_map.
	// it's possible to set your own load_ddo_map adding to something as:
	// tool_common.prototype.build.call(this, autoload, {load_ddo_map : function({
	// 	your own code here to load components
	// })}
	// it will assign or create the context of the tool calling to get_element_context
		const common_build = await tool_common.prototype.build.call(this, autoload);


	return common_build
}//end build



/**
* GENERATE_VIRTUAL_SECTION
* Sends an API request to the server to generate a new virtual ontology section
* (and its thesaurus root terms) from the section currently open in the caller.
*
* Flow
* ----
* 1. Reads `options.force_to_create` (defaults to false) — when true the server
*    will delete any existing hierarchy before regenerating it.
* 2. Builds a `source` descriptor via `create_source` so the server can dispatch
*    the call as `tool_hierarchy::generate_virtual_section(options)`.
* 3. Assembles an `rqo` (request query object) targeting `dd_tools_api / tool_request`.
*    The payload carries the caller's `section_id` and `section_tipo`, which identify
*    the real section to mirror.
* 4. Issues the request via `data_manager.request` with a 60-second timeout and a
*    single retry; wraps it in a Promise so callers can `await` the response.
*
* Server response shape — envelope v2 (tools/tool_hierarchy/server/tool_hierarchy.ts:
* toolHierarchyGenerateVirtualSection; engineering/ERRORS_SPEC.md §3):
*
*   SUCCESS  {ok:true, request_id, data:{state, applied, summary}}
*     state   : {usable, tld, checks:[{id,label,ok,detail}]} — the invariant checklist
*     applied : string[]  — what ensureHierarchy actually CHANGED (empty = already sound)
*     summary : string    — the run sentence (v2 has NO prose `msg` on a success)
*
*   FAILURE  {ok:false, request_id, error:{…}, state, errors}
*     `state` and `errors` are NAMED EXTENSION KEYS at the envelope's TOP level
*     (ERRORS_SPEC §3.0), NOT inside `error.details`: the refused panel re-renders
*     its checklist from `state`, and `errors` is the per-check detail behind it.
*
* (!) SHOW_DEVELOPER is referenced in the debug branch but is NOT declared in the
*     global-comment pragma at the top of this file.  This will trigger an ESLint
*     no-undef error if the linter runs against this module.  Do not fix here —
*     flag only.
*
* @param {Object}  options                       - Configuration object.
* @param {boolean} [options.force_to_create=false] - When true, instructs the server to
*                                                   delete the existing hierarchy before
*                                                   recreating it (destructive operation).
* @returns {Promise<Object>} Resolves with the server response object described above.
*/
tool_hierarchy.prototype.generate_virtual_section = async function(options) {

	const self = this

	const force_to_create = options.force_to_create || false

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'generate_virtual_section')

	// rqo: standard Dédalo request query object; dd_tools_api routes it to
	// tool_hierarchy::generate_virtual_section on the server side.
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				section_id		: self.caller.section_id,
				section_tipo	: self.caller.section_tipo,
				force_to_create : force_to_create
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo,
				retries : 1, // one try only
				timeout : 60 * 1000 // 60 secs waiting response
			})
			.then(function(response){
				// (!) SHOW_DEVELOPER is not declared in the global-comment pragma at the top of this file.
				// ESLint no-undef will flag this reference. Do not fix here — document only.
				if(SHOW_DEVELOPER===true) {
					dd_console("-> generate_virtual_section API response:",'DEBUG',response);
				}

				resolve(response)
			})
		})
}//end generate_virtual_section



/**
* INSPECT_HIERARCHY
* Reads the hierarchy's INVARIANT CHECKLIST from the server (no writes).
*
* The tool used to offer a single blind "Generate" button: you pressed it, and either
* the hierarchy worked or it silently did not — the classic failure was a General Term
* locator pointing at a record that was never created, which left the thesaurus tree
* empty with no visible cause. The server now owns one answer to "is this hierarchy
* usable?" (core/ontology/hierarchy_state.ts inspectHierarchy), and this call fetches it
* so the panel can SHOW the operator which condition failed, and why.
*
* @return {Promise<object>} envelope v2 — the checklist is PAYLOAD:
*   data.state = {usable, tld, checks:[{id,label,ok,detail}]} (read it with response_data)
*/
tool_hierarchy.prototype.inspect_hierarchy = async function() {

	const self = this

	const source = create_source(self, 'inspect_hierarchy')

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: source,
		options	: {
			section_id		: self.caller.section_id,
			section_tipo	: self.caller.section_tipo
		}
	}

	const response = await data_manager.request({
		body	: rqo,
		retries	: 1,
		timeout	: 30 * 1000
	})

	if(SHOW_DEVELOPER===true) {
		dd_console("-> inspect_hierarchy API response:",'DEBUG',response);
	}

	return response
}//end inspect_hierarchy



// @license-end
