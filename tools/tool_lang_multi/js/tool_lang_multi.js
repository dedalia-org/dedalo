// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// import
	import {clone, dd_console, get_json_langs} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {tool_common, load_component} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_lang_multi, is_component_empty} from './render_tool_lang_multi.js'
	import {translate_component_browser, dispose_browser_worker, mark_report_lines} from '../../tool_lang/js/browser_translation.js'
	import {selected_browser_options} from '../../tool_lang/js/translator_engine_select.js'



/**
* TOOL_LANG_MULTI
* Multi-language translation tool for Dédalo v7.
*
* Renders one editable component instance per configured project language side-by-side
* so editors can review and translate content across all languages in a single view.
* Supports two translation modes that can be selected per-session:
*
*   - Browser engine (client-side AI): uses the shared browser_translation worker
*     (the model chosen among those the installation offers — Qwen3 by default — via
*     HuggingFace Transformers + ONNX).  The model is
*     loaded once and kept alive in the worker until destroy() is called.  When
*     translating to multiple targets, requests are serialised (single GPU/worker).
*   - Server engine (babel / google): sends rqo requests to dd_tools_api via
*     data_manager.  Multiple target languages are fired in bounded-concurrency batches
*     of up to SERVER_CONCURRENCY (4) to avoid sequential latency.
*
* Instance properties (beyond tool_common defaults):
*   @property {string}          lang              — Active UI language (page default or option override).
*   @property {Array<Object>}   langs             — Sorted project languages [{label, value, tld2}, …];
*                                                   the current lang is sorted to the front.
*   @property {string}          source_lang       — The lang the user is currently editing (used as
*                                                   translation source). Defaults to the caller's lang.
*   @property {string|null}     target_lang       — Reserved; not used in the current implementation.
*   @property {object|null}     main_element      — Resolved ar_instances entry matching the
*                                                   ddo_map 'main_element' role.
*   @property {string|null}     target_translator — Persisted engine name from local-DB
*                                                   ('translator_engine_select' in 'status' table).
*   @property {Map-like Object} lang_containers   — Keyed by lang value; holds each language's
*                                                   target_component_container HTMLElement.
*                                                   Populated by render_tool_lang_multi.
*   @property {Map-like Object} lang_components   — Keyed by lang value; holds each language's
*                                                   live component instance.
*                                                   Populated asynchronously as spinners resolve.
*   @property {HTMLElement}     status_container  — Shared progress/status banner element.
*   @property {HTMLElement}     translator_engine_select — The engine <select> element.
*   @property {HTMLElement}     translator_device_checkbox — Checkbox selecting wasm (CPU) vs webgpu.
*   @property {Array|null}      json_langs        — Cached language-map data from get_json_langs();
*                                                   lazy-populated on first browser translation call.
*   @property {number|null}     status_hide_timeout — setTimeout handle used to auto-hide the
*                                                   status_container after translate-all completes.
*
* Prototype methods delegated from shared modules:
*   render  → tool_common.prototype.render
*   refresh → common.prototype.refresh
*   edit    → render_tool_lang_multi.prototype.edit
*
* Exports: tool_lang_multi (constructor), translation_summary (the run's account; pure)
*/
export const tool_lang_multi = function () {

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
}//end tool_lang_multi



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	tool_lang_multi.prototype.render	= tool_common.prototype.render
	tool_lang_multi.prototype.refresh	= common.prototype.refresh
	tool_lang_multi.prototype.edit		= render_tool_lang_multi.prototype.edit



/**
* DESTROY
* Free the shared browser translation worker (and its cached model) on close.
*
* Calls dispose_browser_worker() so the (potentially large) ONNX model is
* released from GPU/memory when the tool panel is closed. Then falls through
* to common.prototype.destroy for standard cleanup (event listeners, instances, DOM).
* @returns {boolean} Result from common.prototype.destroy.
*/
tool_lang_multi.prototype.destroy = function() {

	// release the client-side model worker
		dispose_browser_worker()

	return common.prototype.destroy.apply(this, arguments)
}//end destroy



/**
* INIT
* Initialise the tool and compute the ordered language list.
*
* After delegating to tool_common.prototype.init (which seeds common tool
* properties from `options` and rebuilds the caller in window mode), this method:
*   1. Clones page_globals.dedalo_projects_default_langs so the original is untouched.
*   2. Sorts the list so the active lang appears first (better UX — source is at top).
*   3. Appends the synthetic 'lg-nolan' entry when the caller component uses that
*      special no-language mode (lg-nolan is not included in project defaults).
*
* Side effects: sets self.lang, self.langs, self.source_lang, self.target_lang.
*
* @param {Object} options - Tool launch options forwarded from tool_common.
*   @param {string}        [options.lang]   - Override language; falls back to page_globals.dedalo_data_lang.
*   @param {Object|null}   [options.caller] - The component that opened the tool;
*                                            its `lang` is used as the initial source_lang.
* @returns {Promise<boolean>} common_init — the result from tool_common.prototype.init.
*/
tool_lang_multi.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// langs
			const lang	= options.lang || page_globals.dedalo_data_lang
			const langs	= clone(page_globals.dedalo_projects_default_langs)
			// sort current lang as first
			const preferredOrder = [lang];
			langs.sort(function (a, b) {
				return preferredOrder.indexOf(b.value) - preferredOrder.indexOf(a.value);
			});

		// set the self specific vars not defined by the generic init (in tool_common)
			self.lang			= lang // page_globals.dedalo_data_lang
			self.langs			= langs // page_globals.dedalo_projects_default_langs
			self.source_lang	= options.caller ? options.caller.lang : lang
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
				// Add to the beginning
				self.langs.unshift(nolan);
			}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD_CUSTOM
* Build tool state after init: resolve the main_element instance and restore
* the previously selected translator engine from local-DB.
*
* Delegates first to tool_common.prototype.build which loads tool CSS, processes
* ddo_map entries into live instances, and optionally fetches component data.
*
* Then:
*   1. Finds the ar_instances entry whose tipo matches the ddo_map 'main_element' role.
*      All per-language component clones are derived from this entry's context in get_component().
*   2. Reads the 'translator_engine_select' key from the local IndexedDB 'status' table
*      to restore whichever engine the user last selected — so the UI is consistent across
*      sessions without requiring a server round-trip.
*
* Side effects: sets self.main_element, self.target_translator.
*
* @param {boolean} [autoload=false] - Passed through to tool_common.prototype.build;
*   when true, the build fetches fresh data from the API before rendering.
* @returns {Promise<boolean>} common_build — the result from tool_common.prototype.build.
*/
tool_lang_multi.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// main_element. fix main_element for convenience
			const main_element_ddo	= self.tool_config.ddo_map.find(el => el.role==="main_element")
			self.main_element		= self.ar_instances.find(el => el.tipo===main_element_ddo.tipo)

		// target translator. When user changes it, a local DB var is stored as 'translator_engine_select' in table 'status'
			const translator_engine_select_object = await data_manager.get_local_db_data(
				'translator_engine_select',
				'status'
			)
			if (translator_engine_select_object) {
				self.target_translator = translator_engine_select_object.value
			}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom



/**
* GET_COMPONENT
* Asynchronously instantiate and build a component instance for a specific language.
*
* Clones the main_element's context object so each language gets its own isolated
* options bag, then overrides `lang` and `mode` accordingly.  The returned instance
* is already initialised and built (ready to render) via load_component().
*
* `to_delete_instances` is deliberately set to null so every language instance
* remains alive in ar_instances — they are all needed simultaneously on screen.
*
* Called once per language row during the render phase (inside
* create_target_component's ui.load_item_with_spinner callback).
*
* @param {string} lang - BCP-47-style language code (e.g. 'lg-eng', 'lg-spa').
* @returns {Promise<Object>} component_instance — the initialised and built component.
*/
tool_lang_multi.prototype.get_component = async function(lang) {

	const self = this

	// to_delete_instances. Keep every lang instance alive (one component per
	// language is rendered), so nothing is scheduled for deletion here.
		const to_delete_instances = null

	// instance_options (clone context and edit)
		const options = Object.assign(clone(self.main_element.context),{
			self 				: self,
			lang				: lang,
			mode				: 'edit',
			section_id			: self.main_element.section_id,
			to_delete_instances	: to_delete_instances // array of instances to delete after create the new one
		})

	// call generic common tool build
		const component_instance = await load_component(options);


	return component_instance
}//end get_component



/**
* AUTOMATIC_TRANSLATION
* Send a server-side translation request for one source→target language pair.
*
* Builds a standard dd_tools_api rqo and delegates to data_manager.request().
* The tool's server-side handler (tool_lang_multi::automatic_translation) performs
* the actual translation via the named engine (babel, google, etc.) and saves the
* result directly into the component's data column.
*
* After the API responds, the target language component is refreshed in-place
* so the new translation appears without a full page reload.
*
* (!) The translator engine named by `translator` must be present in the tool's
* register.json config (translator_engine list); unknown engine names will cause
* the server handler to return result:false.
*
* (!) Timeout is 3600 s (1 hour) to accommodate large documents or slow engines.
* retries is set to 1 (no retry) because a duplicate request could overwrite a
* partially-saved result.
*
* @param {string}      translator        - Engine name as declared in tool config (e.g. 'babel').
* @param {string}      source_lang       - Source language code (e.g. 'lg-eng').
* @param {string}      target_lang       - Target language code (e.g. 'lg-spa').
* @param {HTMLElement} buttons_container - Element that will receive the status/error message banner.
* @returns {Promise<Object>} api_response — raw response from dd_tools_api:
*   { result: boolean, msg: string, data?: * }
*/
tool_lang_multi.prototype.automatic_translation = async function(translator, source_lang, target_lang, buttons_container) {

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
		const api_response = await data_manager.request({
			body : rqo,
			retries : 1, // one try only
			timeout : 3600 * 1000 // 3600 secs waiting response
		})
		if(SHOW_DEVELOPER===true) {
			dd_console("-> automatic_translation API api_response:",'DEBUG', api_response);
		}

		// user messages. Envelope v2: a failure carries the coded, translated error
		// (`error_text`); a success carries no prose on the wire, so the tool's own
		// label speaks.
			const failed = request_failed(api_response)
			ui.show_message(
				buttons_container,
				failed
					? error_text(api_response.error)
					: (self.get_tool_label('translation_completed') || 'Translation completed'),
				failed ? 'error' : 'ok',
				'component_message',
				true // one current message per slot, not a growing list
			)

		// reload target lang
			const target_component = failed
				? null
				: self.ar_instances.find(el => el.tipo===self.main_element.tipo && el.lang===target_lang)
			if (target_component) {
				target_component.refresh()
			}
			if(SHOW_DEVELOPER===true) {
				dd_console('target_component', 'DEBUG', target_component)
			}

	return api_response
}//end automatic_translation



/**
* SET_SOURCE_LANG
* Set the active source language (the component the user is editing) and update
* the visual highlight. Falls back to DEDALO_DATA_LANG when none was edited.
*
* Iterates over self.lang_containers (populated by render_tool_lang_multi) and
* toggles the 'source' CSS class on the container and the 'bold' class on its
* title element.  This gives the editor a clear visual cue about which language
* will be used as the translation source.
*
* No-ops when `lang` is already the active source (avoids redundant DOM writes)
* or when `lang` is falsy.
*
* Called automatically on 'input' (edit) events of each language component
* (wired in create_target_component inside render_tool_lang_multi.js).
*
* @param {string} lang - Language code to set as source (e.g. 'lg-eng').
* @returns {boolean} true when the source was changed; false when no-op.
*/
tool_lang_multi.prototype.set_source_lang = function(lang) {

	const self = this

	if (!lang || lang===self.source_lang) {
		return false
	}

	self.source_lang = lang

	// update highlight across all language containers
		if (self.lang_containers) {
			Object.entries(self.lang_containers).forEach(([lang_value, container]) => {
				const title = container.querySelector('.target_component_title')
				if (lang_value===lang) {
					container.classList.add('source')
					if (title) title.classList.add('bold')
				}else{
					container.classList.remove('source')
					if (title) title.classList.remove('bold')
				}
			})
		}

	return true
}//end set_source_lang



/**
* SET_SLOT_BUSY
* Mark a language slot as translating (or done): the 'translating' class
* (dims + locks the component, hides its action pill — see the tool CSS) and the
* core spinner node, added once and removed after.
* @param {HTMLElement|null} container - the slot (target_component_container)
* @param {boolean} busy
* @returns {void}
*/
tool_lang_multi.prototype.set_slot_busy = function(container, busy) {

	if (!container) {
		return
	}
	container.classList.toggle('translating', busy)
	const spinner = container.querySelector(':scope > .spinner')
	if (busy && !spinner) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'spinner medium',
			parent			: container
		})
	}else if (!busy && spinner) {
		spinner.remove()
	}
}//end set_slot_busy



/**
* RESOLVE_SOURCE_LANG
* The lang to translate FROM: the current source (last edited lang, else the caller's
* lang) when it has content; otherwise the first configured lang that has some
* (e.g. tool opened in English on a record written only in Spanish), which then
* becomes the highlighted source so the user sees what was used.
* @param {string|null} [exclude] - lang never chosen as fallback (the target)
* @returns {string} source lang
*/
tool_lang_multi.prototype.resolve_source_lang = function(exclude=null) {

	const self = this

	const current	= self.source_lang || self.lang
	const has_text	= (lang) => {
		const component = self.lang_components ? self.lang_components[lang] : null
		return !!component && !is_component_empty(component)
	}
	if (has_text(current)) {
		return current
	}

	const fallback = self.langs.find(el => el.value!==exclude && has_text(el.value))
	if (!fallback) {
		return current
	}
	self.set_source_lang(fallback.value)

	return fallback.value
}//end resolve_source_lang



/**
* RESOLVE_ENGINE
* Resolve the currently selected translator engine and the runtime options
* derived from the UI (engine type and compute device). Shared by
* translate_target and automatic_translation_all to keep them from drifting.
*
* Engine resolution order:
*   1. translator_engine_select DOM element value (what the user currently has in the <select>).
*   2. Falls back to null if no engine is selected or the name cannot be matched.
*
* Device resolution (browser engine only):
*   - translator_device_checkbox checked → 'wasm' (CPU; more compatible, slower).
*   - unchecked (default)               → 'webgpu' (GPU; faster when supported).
*
* @param {Array<Object>} [translator_engine] - Engine config array from tool config;
*   defaults to self.context.config.translator_engine.value if omitted.
*   Each entry: { name: string, label: string, type: 'browser'|'server', … }
* @returns {Object} Resolution result:
*   {
*     translator_name : {string|null}  — selected engine name,
*     engine          : {Object|null}  — matched engine config entry,
*     is_browser      : {boolean}      — true when engine.type === 'browser',
*     device          : {string}       — 'wasm' | 'webgpu'
*     browser_options : {Object}       — { device, engine, model, alternatives, dtype } for the browser
*                                         driver (translator_engine_select.js
*                                         selected_browser_options)
*   }
*/
tool_lang_multi.prototype.resolve_engine = function(translator_engine) {

	const self = this

	const engines			= translator_engine || self.context?.config?.translator_engine?.value || []
	const translator_name	= self.translator_engine_select ? self.translator_engine_select.value : null
	const engine			= engines.find(el => el.name===translator_name)
	const is_browser		= !!(engine && engine.type==='browser')
	const browser_options	= selected_browser_options(self)
	const device			= browser_options.device

	return { translator_name, engine, is_browser, device, browser_options }
}//end resolve_engine



/**
* RUN_BROWSER_TRANSLATION
* Translate one component client-side (browser engine), lazy-loading the
* json_langs map once and reusing it for subsequent calls.
*
* json_langs is a lookup table mapping language codes to names and locale
* strings expected by the ONNX translation model.  It is fetched once and
* cached on self.json_langs to avoid repeated network requests across the
* "translate all" loop.
*
* Delegates to translate_component_browser() (browser_translation.js) which
* drives the shared worker, streams partial results into the target component's
* DOM, and saves the final value when the worker posts 'end'.
*
* The streaming_overlay and streaming_overlay_content DOM elements (attached
* directly to the container in render_tool_lang_multi.js) are passed through so
* the browser engine can render live streaming text while the model generates.
*
* @param {Object} options
* @param {Object}      options.source_component - Live component instance whose data is the translation source.
* @param {Object}      options.target_component - Live component instance that receives the translated text.
* @param {string}      options.source_lang      - Source language code (e.g. 'lg-eng').
* @param {string}      options.target_lang      - Target language code (e.g. 'lg-spa').
* @param {string}      options.device           - Compute device: 'wasm' (CPU) | 'webgpu' (GPU).
* @param {string|null} [options.dtype]          - Quantisation override (one of the chosen model's pinned dtypes).
* @param {string|null} [options.engine]         - Selected model name.
* @param {Object|null} [options.model]          - Selected model definition from the tool config.
* @param {Array}       [options.alternatives]   - The offered models a 'try a smaller model' refusal may name.
* @param {HTMLElement} [options.container]      - The target_component_container; if present, its
*                                                 .streaming_overlay and .streaming_overlay_content
*                                                 properties are forwarded to the worker driver.
* @returns {Promise<*>} Result from translate_component_browser (resolves when translation is saved).
*/
tool_lang_multi.prototype.run_browser_translation = async function(options) {

	const self		= this
	const container	= options.container || null

	if (!self.json_langs) {
		self.json_langs = await get_json_langs() || []
	}

	return translate_component_browser({
		source_component			: options.source_component,
		target_component			: options.target_component,
		source_lang					: options.source_lang,
		target_lang					: options.target_lang,
		device						: options.device,
		dtype						: options.dtype || null,
		engine						: options.engine || null,
		model						: options.model || null,
		alternatives				: options.alternatives || [],
		status_container			: self.status_container,
		streaming_overlay			: container ? container.streaming_overlay : null,
		streaming_overlay_content	: container ? container.streaming_overlay_content : null,
		json_langs					: self.json_langs,
		get_label					: (key, ...args) => self.get_tool_label(key, ...args)
	})
}//end run_browser_translation



/**
* TRANSLATE_TARGET
* Translate the current source component into one target language using the
* selected engine (browser = client-side AI, or server = babel/google).
*
* This is the per-language entry point used both by the individual translate
* button wired into each language component's button bar and by the
* translate_one closure inside automatic_translation_all.
*
* Engine dispatch:
*   - is_browser → run_browser_translation (serialised in the caller for multi-target).
*   - otherwise  → automatic_translation (server API call).
*
* When the browser engine is selected but the source component is not yet loaded
* in self.lang_components, an error banner is shown and the promise rejects.
*
* @param {Object} options
* @param {string}      options.target_lang       - Target language code (e.g. 'lg-spa').
* @param {Object}      options.target_component  - Live component instance to receive the translation.
* @param {HTMLElement} [options.container]       - Target component's outer container element;
*                                                  used for the streaming overlay and error messages.
* @param {Array}       [options.translator_engine] - Engine config array; defaults to tool config.
* @param {string}      [options.source_lang]     - Source language override; defaults to self.source_lang.
* @returns {Promise<*>} Result from the chosen engine call.
*/
tool_lang_multi.prototype.translate_target = async function(options) {

	const self = this

	// options
		const target_lang		= options.target_lang
		const target_component	= options.target_component
		const container			= options.container || null
		const source_lang		= options.source_lang || self.resolve_source_lang(target_lang)
		const translator_engine	= options.translator_engine || (self.context?.config?.translator_engine?.value ?? [])

	// resolve selected engine
		const { translator_name, is_browser, browser_options } = self.resolve_engine(translator_engine)

	// browser engine (client-side AI)
		if (is_browser) {

			const source_component = self.lang_components ? self.lang_components[source_lang] : null
			if (!source_component) {
				ui.show_message(self.status_container, self.get_tool_label('empty_source') || 'Source component not available', 'error', 'component_message', true)
				return Promise.reject('Source component not available')
			}

			return self.run_browser_translation({
				...browser_options,
				source_component	: source_component,
				target_component	: target_component,
				source_lang			: source_lang,
				target_lang			: target_lang,
				container			: container
			})
		}

	// server engine (babel / google)
		return self.automatic_translation(translator_name, source_lang, target_lang, container)
}//end translate_target



/**
* AUTOMATIC_TRANSLATION_ALL
* One-click translation of the current source component into every configured
* language (except the source). Opens an overwrite/skip modal first; holding
* Alt while clicking overwrites without the modal.
*
* Pre-flight checks (each returns false early with a status banner):
*   - No translator engines configured in tool config → abort.
*   - Not all lang_components are loaded yet (async spinners) → abort with 'loading' message.
*   - Source component is empty (is_component_empty) → abort with 'empty_source' message.
*
* Overwrite policy:
*   - Alt+click → 'overwrite' unconditionally (skips the modal for power users).
*   - Normal click → asks the user via ask_overwrite_mode modal:
*       'overwrite' — translate all targets regardless of existing content.
*       'skip'      — only translate targets whose value is currently empty.
*       null (modal closed) — cancel; returns false.
*
* Scheduling strategy:
*   - Browser engine: targets translated sequentially (single shared GPU/worker).
*   - Server engine:  targets translated in batches of SERVER_CONCURRENCY (4)
*     concurrent requests via Promise.all to cut latency without hammering the
*     external service.
*
* After all targets complete, a summary banner 'completed (n/total)' is shown in
* status_container, then the container auto-hides after ~10.5 s.
*
* @param {Object}    [options={}]   - Options bag.
* @param {MouseEvent} [options.event] - The originating click event; used to
*   detect Alt key for no-modal overwrite.
* @returns {Promise<Array<Object>|boolean>} Array of per-lang results
*   [{ lang: string, ok: boolean }, …], or false on abort/cancel.
*/
tool_lang_multi.prototype.automatic_translation_all = async function(options={}) {

	const self		= this
	const event		= options.event || null

	// show_status. Reveal the status container (it starts hidden, and CSS
	// `display:none` would otherwise swallow the message) and render a banner
	// into it. Any pending auto-hide from a previous run is cancelled.
		const show_status = (message, msg_type) => {
			if (!self.status_container) {
				return
			}
			clearTimeout(self.status_hide_timeout)
			self.status_container.classList.remove('hide')
			ui.show_message(self.status_container, message, msg_type, 'component_message', true)
		}

	// engines from tool config
		const translator_engine = self.context?.config?.translator_engine?.value ?? []
		if (!translator_engine || translator_engine.length<1) {
			return false
		}

	// components readiness. Target components load asynchronously (see
	// create_target_component). Bail out with a clear message if they are not
	// all available yet, instead of misreporting an empty source or silently
	// skipping not-yet-loaded targets.
		const loaded_count = self.lang_components ? Object.keys(self.lang_components).length : 0
		if (loaded_count < self.langs.length) {
			show_status(self.get_tool_label('loading') || 'Components are still loading, please wait', 'error')
			return false
		}

	// source. The last edited lang, else DEDALO_DATA_LANG (self.lang), else
	// the first lang with content (resolve_source_lang)
		const source_lang		= self.resolve_source_lang()
		const source_component	= self.lang_components ? self.lang_components[source_lang] : null
		if (!source_component || is_component_empty(source_component)) {
			show_status(self.get_tool_label('empty_source') || 'Source text is empty', 'error')
			return false
		}

	// overwrite policy. Alt+click overwrites without asking, else open modal
		let mode // 'overwrite' | 'skip'
		if (event && event.altKey) {
			mode = 'overwrite'
		}else{
			mode = await ask_overwrite_mode(self)
			if (!mode) {
				return false // cancelled
			}
		}

	// target langs (all configured except the source)
		const targets = self.langs.filter(item => item.value!==source_lang)

	// resolve engine type once
		const { translator_name, is_browser, browser_options } = self.resolve_engine(translator_engine)

	// status. Reveal the (initially hidden) progress area for the run.
		if (self.status_container) {
			clearTimeout(self.status_hide_timeout)
			self.status_container.classList.remove('hide')
		}

	// translate_one. Translate a single target lang and return its result, or
	// null when the target is missing or skipped (mode==='skip' on non-empty).
		const translate_one = async (lang) => {

			const target_component	= self.lang_components ? self.lang_components[lang.value] : null
			const container			= self.lang_containers ? self.lang_containers[lang.value] : null

			if (!target_component) {
				return null
			}

			// skip non-empty targets when mode is 'skip'
				if (mode==='skip' && is_component_empty(target_component)===false) {
					return null
				}

			self.set_slot_busy(container, true)

			let ok = true
			// the driver's report when the value was saved with positions WE chose: the
			// per-lang status lines it painted are overwritten by the next lang's run, so
			// the summary below carries them (A1-02 review)
			let warnings = null
			try {
				if (is_browser) {
					// done only when the driver says the value is stored: it resolves
					// {result:false} on a cancelled run or a soft worker error (nothing
					// saved) and rejects on a refused run or a save that did not land
					const response = await self.run_browser_translation({
						...browser_options,
						source_component	: source_component,
						target_component	: target_component,
						source_lang			: source_lang,
						target_lang			: lang.value,
						container			: container
					})
					ok = response?.result===true
					warnings = ok ? (response.warnings || null) : null
				}else{
					// a refusal (e.g. translation.empty_result: the engine does not
					// support this lang) resolves, it does not throw: count it here
					const api_response = await self.automatic_translation(translator_name, source_lang, lang.value, container)
					ok = !request_failed(api_response)
				}
			} catch (error) {
				console.error('automatic_translation_all error for', lang.value, error)
				ok = false
			}

			self.set_slot_busy(container, false)

			return { lang: lang.value, label: lang.label, ok: ok, warnings: warnings }
		}//end translate_one

	// schedule. The browser engine reuses a single GPU/worker, so it must run
	// one lang at a time. The server engine (babel/google) fires independent
	// network requests, so we run them in bounded-concurrency batches to avoid
	// N× sequential latency without overwhelming the external service.
		const results = []
		if (is_browser) {
			for (let i = 0; i < targets.length; i++) {
				const result = await translate_one(targets[i])
				if (result) {
					results.push(result)
				}
			}
		}else{
			const SERVER_CONCURRENCY = 4
			for (let i = 0; i < targets.length; i += SERVER_CONCURRENCY) {
				const batch		= targets.slice(i, i + SERVER_CONCURRENCY)
				const settled	= await Promise.all(batch.map(translate_one))
				for (let j = 0; j < settled.length; j++) {
					if (settled[j]) {
						results.push(settled[j])
					}
				}
			}
		}

	// summary message. The 'ok' banner auto-dismisses (~10s, handled by
	// ui.show_message); re-hide the now-empty status area shortly after so it
	// does not leave a lingering blank row. A summary naming failures or warnings
	// stays until the user dismisses it (translation_summary).
		if (self.status_container) {
			const summary = translation_summary(results, (key, ...args) => self.get_tool_label(key, ...args))
			ui.show_message(self.status_container, summary.text, summary.needs_attention ? 'warning' : 'ok', 'component_message', true)
			// what to check, per language
			for (const line of summary.details) {
				ui.show_message(self.status_container, line, 'warning', 'component_message', false)
			}
			if (summary.needs_attention===false) {
				self.status_hide_timeout = setTimeout(() => {
					self.status_container.classList.add('hide')
				}, 10500)
			}
		}

	return results
}//end automatic_translation_all



/**
* TRANSLATION_SUMMARY
* The operator-facing account of a multi-language run: one summary line, plus one detail
* line per language saved WITH WARNINGS (marks we placed or reordered — the operator must
* check them; browser_translation.js mark_report_lines).
*
* Failed languages are named (each failed slot also carries its own error banner);
* warned languages are named too, and either keeps the summary on screen
* (needs_attention) instead of letting it auto-hide like a clean run's.
* @param {Array<{label:string, ok:boolean, warnings:Object|null}>} results - one per target
* @param {Function} get_label - (key, ...args) => string|null; the tool label resolver
* @returns {{text:string, details:string[], needs_attention:boolean}}
*/
export const translation_summary = function(results, get_label) {

	const ok_count			= results.filter(r => r.ok).length
	const failed_labels		= results.filter(r => !r.ok).map(r => r.label)
	const warned			= results.filter(r => r.ok && r.warnings)
	const completed_label	= get_label('translation_completed') || 'Translation completed'

	let text = `${completed_label} (${ok_count}/${results.length})`
	if (failed_labels.length > 0) {
		text += ` — ✕ ${failed_labels.join(', ')}`
	}
	if (warned.length > 0) {
		const warn_label = get_label('translation_saved_with_warnings') || 'Translation saved — check the marks'
		text += ` — ⚠ ${warn_label}: ${warned.map(r => r.label).join(', ')}`
	}

	const details = warned.map(
		(result) => `${result.label}: ${mark_report_lines(result.warnings, get_label).join(' · ')}`
	)

	return {
		text,
		details,
		needs_attention : failed_labels.length > 0 || warned.length > 0
	}
}//end translation_summary



/**
* ASK_OVERWRITE_MODE
* Open a modal asking whether to overwrite existing translations or skip
* languages that already have content.
*
* The modal contains two buttons:
*   - "Skip non-empty" (secondary) → resolves 'skip'.
*   - "Overwrite all" (warning)    → resolves 'overwrite'.
* Closing via the X button or the backdrop resolves null (cancel).
*
* A `resolved` guard prevents the promise from settling more than once when
* both a button and the on_close handler fire in quick succession.
*
* (!) This is a module-private helper — not exported or attached to the prototype.
*
* @param {Object} self - The tool_lang_multi instance (used for labels and ui.attach_to_modal).
* @returns {Promise<string|null>} 'overwrite' | 'skip' | null (cancelled).
*/
const ask_overwrite_mode = (self) => {

	return new Promise(function(resolve){

		let resolved = false
		const finish = (mode) => {
			if (resolved) {
				return
			}
			resolved = true
			resolve(mode)
		}

		// Same shape and look as ui.confirm (dd_confirm: header > label, body.content,
		// footer.content), but with two choices — ui.confirm is yes/no only.
		// header
			const header = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'header'
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'label',
				text_content	: self.get_tool_label('automatic_translation') || 'Automatic translation',
				parent			: header
			})

		// body
			const body = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'body content',
				text_content	: self.get_tool_label('translate_all_confirm') || 'Translate the source text into all languages?'
			})

		// footer
			const footer = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'footer content'
			})
			// skip non-empty
				const button_skip = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'secondary skip',
					text_content	: self.get_tool_label('skip_non_empty') || 'Skip non-empty',
					parent			: footer
				})
				button_skip.addEventListener('click', function(e){
					e.stopPropagation()
					finish('skip')
					modal.close()
				})
			// overwrite all
				const button_overwrite = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'warning overwrite',
					text_content	: self.get_tool_label('overwrite') || 'Overwrite all',
					parent			: footer
				})
				button_overwrite.addEventListener('click', function(e){
					e.stopPropagation()
					finish('overwrite')
					modal.close()
				})

		// modal. Any other close (X / overlay / Esc) resolves null: no choice made
			const modal = ui.attach_to_modal({
				header		: header,
				body		: body,
				footer		: footer,
				size		: 'small',
				minimizable	: false,
				transient	: true,
				callback	: (dd_modal) => {
					dd_modal.classList.add('dd_confirm')
					requestAnimationFrame(() => button_skip.focus())
				}
			})

		// gesture guard (same as ui.confirm): dd-modal dismisses on mousedown, so the
		// second mousedown of a double click on the opening button would hit the
		// overlay and cancel unseen. Overlay mousedowns inside 400ms are swallowed.
			const opened_at		= performance.now()
			const gesture_guard	= (e) => {
				if ((performance.now() - opened_at) >= 400) {
					document.removeEventListener('mousedown', gesture_guard, true)
					return
				}
				if (e.composedPath()[0]===modal.get_modal_node()) {
					e.stopPropagation()
				}
			}
			document.addEventListener('mousedown', gesture_guard, true)

			modal.addEventListener('dd-modal-close', () => {
				document.removeEventListener('mousedown', gesture_guard, true)
				finish(null)
			})
	})
}//end ask_overwrite_mode



// @license-end
