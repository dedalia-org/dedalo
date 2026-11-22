// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// import
	import {clone, dd_console, get_json_langs} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {common, create_source, rebuild_component_in_lang} from '../../../core/common/js/common.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {tool_common, load_component} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_lang} from './render_tool_lang.js'
	import {translate_component_browser} from './browser_translation.js'



/**
* TOOL_LANG
* Tool to translate the content of a single text component from one Dédalo language
* to another, supporting both server-side (Babel/Google Translate) and fully
* client-side (TranslateGemma 4B via WebGPU/WASM Web Worker) translation modes.
*
* Responsibilities:
*  - Maintains a "source component" (the component being translated, keyed by its
*    original lang) and a "target component" (a second live instance of the same
*    component tipo loaded for the chosen target language).
*  - Reads user preferences for the last-used target language and translator engine
*    from the browser's local DB (IndexedDB table 'status') so the UI is sticky
*    across tool re-opens.
*  - Handles the special 'lg-nolan' pseudo-language (records with no language
*    assignment) which is absent from page_globals.dedalo_projects_default_langs.
*
* Lifecycle: init() → build() → render() (delegated to render_tool_lang.edit).
*
* Prototype chain wired below:
*  - render    ← tool_common  (standard tool wrapper render)
*  - destroy   ← common       (instance teardown + DOM cleanup)
*  - refresh   ← common       (rebuild without full re-init)
*  - edit      ← render_tool_lang (the concrete DOM layout for this tool)
*
* @see tools/tool_lang/js/render_tool_lang.js   — DOM rendering / UI
* @see tools/tool_lang/js/browser_translation.js — client-side AI pipeline
*/
export const tool_lang = function () {

	this.id				= null
	this.model			= null
	this.mode			= null
	this.node			= null
	this.ar_instances	= null
	this.status			= null
	this.events_tokens	= null
	this.type			= null
	this.source_lang	= null
	this.target_lang	= null
	this.langs			= null
	this.caller			= null


	return true
}//end page



/**
* COMMON FUNCTIONS
* Extend tool_lang with shared prototype methods from tool_common, common, and
* render_tool_lang. These assignments replace what was formerly repeated in every
* tool file.
*
* Prototype assignments:
*  - render  : tool_common.prototype.render  — generic tool wrapper + error fallback
*  - destroy : common.prototype.destroy      — DOM teardown and event cleanup
*  - refresh : common.prototype.refresh      — teardown + rebuild cycle (re-runs build)
*  - edit    : render_tool_lang.prototype.edit — this tool's concrete 'edit' layout
*/
// prototypes assign
	// tool_lang.prototype.render	= common.prototype.render
	tool_lang.prototype.render		= tool_common.prototype.render
	tool_lang.prototype.destroy		= common.prototype.destroy
	tool_lang.prototype.refresh		= common.prototype.refresh
	tool_lang.prototype.edit		= render_tool_lang.prototype.edit



/**
* INIT
* Seed tool-specific state on top of the base initialization provided by
* tool_common.prototype.init(). Called once, immediately after the tool instance
* is constructed, before build().
*
* After the base init completes this method sets:
*  - self.langs       — clone of page_globals.dedalo_projects_default_langs so the UI
*                       has a local, mutable list of language options.
*  - self.source_lang — inherited from the calling component's lang (self.caller.lang),
*                       or null when the tool is opened without a caller context.
*  - self.target_lang — null here; resolved from local DB in build().
*
* lg-nolan injection:
*   If the caller component has lang 'lg-nolan' (a special pseudo-language that marks
*   records with no language assignment), it is injected into self.langs because it is
*   intentionally absent from the global list. Without this step the source language
*   selector would not show an entry for 'lg-nolan'.
*
* Translator engine preference:
*   The last-used translator engine is persisted as key 'translator_engine_select' in
*   the IndexedDB 'status' table. It is loaded here and stored as self.target_translator
*   so the render layer can pre-select the right engine in the dropdown.
*
* @param {Object} options - Options forwarded to tool_common.prototype.init
* @returns {Promise<boolean>} Resolves with the result of tool_common.prototype.init
*/
tool_lang.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// set the self specific vars not defined by the generic init (in tool_common)
			self.langs			= clone(page_globals.dedalo_projects_default_langs)
			self.source_lang	= self.caller && self.caller.lang
				? self.caller.lang
				: null
			self.target_lang	= null

			// lg-nolan case. If the tool is open from a nolan component, add the
			// component lang to the langs list because is not added by default in the page_globals.dedalo_projects_default_langs.
			const found = self.langs.find(el => el.value===self.source_lang)
			if (!found && self.source_lang==='lg-nolan') {
				const nolan = {
					label	: 'No lang',
					value	: 'lg-nolan',
					tld2	: 'nolan'
				}
				self.langs.push(nolan);
			}

		// target translator. When user changes it, a local DB var is stored as 'translator_engine_select' in table 'status'
			const translator_engine_select_object = await data_manager.get_local_db_data(
				'translator_engine_select',
				'status'
			)
			if (translator_engine_select_object) {
				self.target_translator = translator_engine_select_object.value
			}

		// debug
			if(SHOW_DEBUG===true) {
				console.log('self [tool_lang]:', self);
			}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* Custom build step that extends tool_common.prototype.build() with tool-specific
* instance resolution and target-language component loading.
*
* After the base build resolves ddo_map entries into live instances (stored in
* self.ar_instances), this method:
*
*  1. Resolves self.main_element — the component instance whose tipo matches the
*     ddo_map entry with role 'main_element'. This is the source component that will
*     be translated.
*
*  2. related_component_lang override — when the main_element's context.options
*     carries a 'related_component_lang', that lang overrides the initial source_lang.
*     This happens when tool_lang is opened from a multi-lang context (e.g. a portal
*     listing) where the component's active lang differs from the "original" lang the
*     caller recorded. The main_element is rebuilt with the corrected lang to load
*     fresh data from the API.
*
*  3. status_user_component / status_admin_component — two optional ddo_map entries
*     (role 'status_user_component' and 'status_admin_component') provide components
*     used to show workflow-status information to translators and administrators
*     respectively. Both are stored on self for use in the render layer.
*
*  4. target_lang resolution — reads the key 'tool_lang_target_lang' from IndexedDB
*     ('status' table). If found, it is used as the target language; otherwise self.lang
*     (the tool's own interface language) is used as a sensible default.
*
*  5. target_component — a second live instance of the same component tipo, loaded via
*     load_component() with the resolved target_lang and id_variant 'target_component'
*     to prevent key collisions in the instances registry. This is the component that
*     will receive the translated value.
*
* @param {boolean} [autoload=false] - When true, triggers an API data fetch during build
* @returns {Promise<boolean>} Resolves with the result of tool_common.prototype.build
*/
tool_lang.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// main_element. fix main_element for convenience
			const main_element_ddo = self.tool_config.ddo_map.find(el => el.role==='main_element')
			if (main_element_ddo) {
				self.main_element = self.ar_instances.find(el => el.tipo===main_element_ddo.tipo)
			}
			// overwrite default lang from options.related_component_lang if exists (original lang)
			// rebuild_component_in_lang (common.js) sets lang + context.lang and forces
			// the reload: build() MEMOIZES, so the previous bare build(true) never
			// re-fetched and the main element kept the MENU lang's value.
			const original_lang = self.main_element.context.options
				? self.main_element.context.options.related_component_lang
				: null
			if (await rebuild_component_in_lang(self.main_element, original_lang)) {
				self.source_lang = self.main_element.lang
				self.target_lang = null
			}

		// status_user_component. control the tool status process for users
			const status_user_ddo = self.tool_config.ddo_map.find(el => el.role==='status_user_component')
			if (status_user_ddo) {
				self.status_user_component = self.ar_instances.find(el => el.tipo===status_user_ddo.tipo)
			}

		// status_admin_component. control the tool status process for administrators
			const status_admin_ddo = self.tool_config.ddo_map.find(el => el.role==='status_admin_component')
			if (status_admin_ddo) {
				self.status_admin_component	= self.ar_instances.find(el => el.tipo===status_admin_ddo.tipo)
			}

		// target lang. When user changes it, a local DB var is stored as 'tool_lang_target_lang' in table 'status'
			const tool_lang_target_lang_object = await data_manager.get_local_db_data(
				'tool_lang_target_lang',
				'status'
			)
			self.target_lang = (tool_lang_target_lang_object)
				? tool_lang_target_lang_object.value
				: self.lang
			if (main_element_ddo) {
				self.target_component = await load_component({
					self 			: self,
					model			: main_element_ddo.model,
					mode			: main_element_ddo.mode,
					tipo			: main_element_ddo.tipo,
					section_tipo	: main_element_ddo.section_tipo,
					section_lang	: main_element_ddo.section_lang,
					lang			: self.target_lang,
					type			: main_element_ddo.type,
					section_id		: main_element_ddo.section_id,
					id_variant		: 'target_component'
				})
			}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build



/**
* AUTOMATIC_TRANSLATION_BROWSER
* Run translation entirely client-side using a Web Worker with
* the transformers.js library and the TranslateGemma 4B model
*
* The worker is module-level and reused across calls (see browser_translation.js)
* so the model is downloaded and compiled only once per page session. The first
* call may be slow (model download + GPU compilation); subsequent calls for the
* same source/target lang pair are fast.
*
* self.json_langs is cached on the instance to avoid re-fetching the lang map on
* every translation call (the map is the same for the lifetime of the tool).
*
* Delegates the full orchestration pipeline (HTML → Markdown → chunk → worker
* → stream → restore → save) to translate_component_browser().
*
* @param {Object} options - Translation options
* @param {string} options.source_lang - Dédalo lang tag for the source, e.g. 'lg-eng'
* @param {string} options.target_lang - Dédalo lang tag for the target, e.g. 'lg-spa'
* @param {string} [options.device='webgpu'] - ONNX runtime backend: 'webgpu' or 'wasm'
* @param {HTMLElement} options.status_container - Element used to stream status/progress messages
* @returns {Promise<Object>} Resolves with the response from translate_component_browser
*/
tool_lang.prototype.automatic_translation_browser = async function(options) {

	const self = this

	// delegate to the shared client-side engine, reusing the cached worker.
	// json_langs is cached on the instance to avoid re-fetching the lang map.
		if (!self.json_langs) {
			self.json_langs = await get_json_langs() || []
		}

		return translate_component_browser({
			source_component			: self.main_element,
			target_component			: self.target_component,
			source_lang					: options.source_lang,
			target_lang					: options.target_lang,
			device						: options.device || 'webgpu',
			status_container			: options.status_container,
			streaming_overlay			: self.streaming_overlay,
			streaming_overlay_content	: self.streaming_overlay_content,
			json_langs					: self.json_langs,
			get_label					: (key, ...args) => self.get_tool_label(key, ...args)
		})
}//end automatic_translation_browser



/**
* AUTOMATIC_TRANSLATION_SERVER
* Trigger a server-side translation via the dd_tools_api and persist the result
* back to the target-language component. Supports pluggable translation engines
* (Babel, Google Translate, etc.) as configured in the tool's register.json.
*
* The request is built with create_source() so the server knows which tool
* function to invoke (tool_lang::automatic_translation). The resolved action on
* the server is: my_tool_name::automatic_translation(options).
*
* The request uses a generous 3600-second timeout because machine translation of
* a large text field on a remote service can be slow, and 5 retries because
* transient network errors should not abort a long-running operation.
*
* (!) The comment `retries : 5, // one try only` in the source is misleading —
*     5 means 5 total retries, not "one try only". Flagged for clarification.
*
* On success, the target language component instance is located in self.ar_instances
* by matching both tipo and lang, then refreshed so the user sees the new value
* without a full page reload.
*
* (!) Tool lang config translator must exist in the register_tools section of the
*     tool's server-side configuration, otherwise the server will reject the request.
*
* @param {string} translator - Named engine key (e.g. 'babel') defined in tool config
* @param {string} source_lang - Source language tag, e.g. 'lg-eng'
* @param {string} target_lang - Target language tag, e.g. 'lg-spa'
* @param {HTMLElement} buttons_container - Element where the user-facing response message is shown
* @returns {Promise<Object>} Resolves with the raw API response object
*/
tool_lang.prototype.automatic_translation_server = async function(translator, source_lang, target_lang, buttons_container) {

	const self = this

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'automatic_translation')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				source_lang		: source_lang,
				target_lang		: target_lang,
				component_tipo	: self.main_element.tipo,
				section_id		: self.main_element.section_id,
				section_tipo	: self.main_element.section_tipo,
				translator		: translator,
				config			: self.context.config
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo,
				retries : 5, // one try only
				timeout : 3600 * 1000 // 3600 secs waiting response
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> automatic_translation API response:",'DEBUG',response);
				}

				// user messages. Envelope v2: a failure carries the coded, translated
				// error (`error_text`); a success carries no prose on the wire, so the
				// tool's own label speaks.
					if (request_failed(response)) {
						ui.show_message(buttons_container, error_text(response.error), 'error')
					}else{
						ui.show_message(buttons_container, self.get_tool_label('translation_completed') || 'Translation completed.', 'ok')
					}

				// reload target lang (only when the translation actually landed)
					const target_component = request_failed(response)
						? null
						: self.ar_instances.find(el => el.tipo===self.main_element.tipo && el.lang===target_lang)
					if (target_component) {
						target_component.refresh()
					}
					if(SHOW_DEVELOPER===true) {
						dd_console('target_component', 'DEBUG', target_component)
					}

				resolve(response)
			})
		})
}//end automatic_translation_server




// @license-end
