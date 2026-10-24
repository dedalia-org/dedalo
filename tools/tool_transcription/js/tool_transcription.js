// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* TOOL_TRANSCRIPTION (module)
*
* Dédalo tool that provides a side-by-side audiovisual player + text-area workspace
* for creating and editing transcriptions of media resources. The tool surfaces in a
* new browser window (`open_as: "window"` in register.json) launched from a section
* toolbar button.
*
* Architectural overview
* ----------------------
* The tool follows the standard Dédalo tool lifecycle (tool_common):
*   init(options) → build(autoload) → render() → edit()
*
* After `build()`, five named component roles are resolved from `tool_config.ddo_map`
* and attached as direct properties (see `build` for the role list).  The two primary
* roles are:
*   - `media_component`          — a component_av (or compatible) rendered in 'player'
*                                   view on the right side; the audio source for all
*                                   transcription operations.
*   - `transcription_component`  — a component_text_area rendered in edit mode on the
*                                   left; receives and stores the transcription text.
*
* Transcription engines
* ---------------------
* Two engine paths exist, selected at runtime by the user via a drop-down:
*
*   browser  (default) — runs OpenAI Whisper ONNX entirely in the client via a
*                         Web Worker (`browser_whisper.js`).  The server only prepares
*                         the audio file; all neural-network inference happens client-side
*                         using WebGPU (preferred) or WASM (fallback / compatibility
*                         mode, limited to small models due to RAM constraints).
*
*   server             — delegates the entire transcription job to a remote service
*                         (e.g. Babel); the client polls for completion via
*                         `check_server_transcriber_status`.
*
* The browser path resolves to the `component_text_area` value shape — an array
* holding one HTML string of TC-tagged paragraphs, built by the shared
* `transcribers/lib/paragraphs.js` (`segments_to_html`); the server path writes
* the same shape server-side. An empty recognition NEVER becomes a value: it
* resolves `false`, so the existing transcript is never overwritten by nothing.
*
* Subtitle generation
* -------------------
* `build_subtitles_file` requests the server to compute a WebVTT file from the current
* transcription text.  On success it publishes `updated_subtitles_file_<media_id>` so
* any open component_av player immediately reloads its captions track.
*
* Persistence
* -----------
* The transcription text is saved through the normal component_text_area save flow
* (no tool-specific persistence).  The selected transcriber engine and quality level
* are persisted in the client-side IndexedDB `status` table via `data_manager.set_local_db_data`
* so user preferences survive page reloads.
*
* Exported symbols
* ----------------
*   tool_transcription    — tool constructor (prototype methods below)
*   get_current_lang_info — utility that formats a lang code as "Label | tld3 | tld2"
*/



// import
	import { dd_console, get_json_langs } from '../../../core/common/js/utils/index.js'
	import { data_manager } from '../../../core/common/js/data_manager.js'
	import { refused_by_page_identity } from '../../../core/common/js/error_dispatch.js'
	import { request_failed, response_data } from '../../../core/common/js/api_error.js'
	import { error_text } from '../../../core/common/js/render_api_error.js'
	import { common, create_source, rebuild_component_in_lang } from '../../../core/common/js/common.js'
	import { tool_common } from '../../../core/tools_common/js/tool_common.js'
	import { render_tool_transcription } from './render_tool_transcription.js'
	import { parse_transcript, segments_to_html, tc_to_seconds } from '../transcribers/lib/paragraphs.js'
	import { ui } from '../../../core/common/js/ui.js'
	import { installed_answer, MODEL_STATES, model_state_of } from './transcription_report.js'



/**
* TOOL_TRANSCRIPTION
* Tool to translate contents from one language to other in any text component
*/
export const tool_transcription = function () {

	// @var {string|null} id - Instance identifier assigned by get_instance.
	this.id							= null
	// @var {string|null} model - Always 'tool_transcription'; set by tool_common.init.
	this.model						= null
	// @var {string|null} mode - Render mode (typically 'edit').
	this.mode						= null
	// @var {HTMLElement|null} node - Root DOM node once rendered.
	this.node						= null
	// @var {Array} ar_instances - Component instances built from tool_config.ddo_map.
	this.ar_instances				= null
	// @var {string|null} status - Lifecycle state: 'initializing' | 'initialized' | 'building' | 'built'.
	this.status						= null
	// @var {Array} events_tokens - Subscription tokens returned by event_manager.subscribe;
	//   collected here so destroy() can unsubscribe them all.
	this.events_tokens				= []
	// @var {string|null} type - Always 'tool'; set by tool_common.init.
	this.type						= null
	// @var {string|null} source_lang - Language code of the source transcription (e.g. 'lg-spa');
	//   derived from transcription_component.lang after build resolves related_component_lang.
	this.source_lang				= null
	// @var {string|null} target_lang - Reserved for future translation target; currently unused.
	this.target_lang				= null
	// @var {Array|null} langs - Array of language objects from page_globals.dedalo_projects_default_langs.
	this.langs						= null
	// @var {Object|null} caller - The section or component instance that opened this tool.
	this.caller						= null
	// @var {Object|null} media_component - component_av (or compatible) to be transcribed;
	//   matched from ar_instances via the 'media_component' role in tool_config.ddo_map.
	this.media_component			= null // component av that will be transcribed (it could be the caller)
	// @var {Object|null} transcription_component - component_text_area where the transcription
	//   text is authored; matched via the 'transcription_component' role in tool_config.ddo_map.
	this.transcription_component	= null // component text area where we are working into the tool
	// @var {Object|null} relation_list - API datum from load_relation_list; contains the list
	//   of top-section locators (section_tipo / section_id pairs) that reference the current record.
	this.relation_list				= null // datum of relation_list (to obtaim list of top_section_tipo/id)

	return true
}//end page



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	tool_transcription.prototype.render		= tool_common.prototype.render
	tool_transcription.prototype.destroy	= common.prototype.destroy
	tool_transcription.prototype.refresh	= common.prototype.refresh
	tool_transcription.prototype.edit		= render_tool_transcription.prototype.edit



/**
* INIT
* Initialises the tool instance by delegating to `tool_common.prototype.init` and then
* setting tool-specific properties that are not handled by the generic init.
*
* After the generic init resolves:
*   - `self.langs` is populated from `page_globals.dedalo_projects_default_langs`.
*   - `self.target_lang` is reset to null (translation target; not used in the current
*     release but reserved for future machine-translation integration).
*   - The previously selected transcriber engine is restored from the client-side
*     IndexedDB `status` table under the key `'transcriber_engine_select'`, so the
*     user's last choice is applied on the next open.
*
* The commented-out `self.source_lang` block below is intentionally preserved (dead code);
* source_lang is now derived inside `build` from `transcription_component.context.options`.
*
* @param {Object} options - Standard tool_common init options (caller, model, lang, etc.)
* @returns {Promise<boolean>} Result from tool_common.prototype.init (true on success).
*/
tool_transcription.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// set the self specific vars not defined by the generic init (in tool_common)
			self.langs			= page_globals.dedalo_projects_default_langs
			// self.source_lang	= self.caller && self.caller.lang
			// 	? self.caller.lang
			// 	: null
			self.target_lang	= null

		// target transcriber. When user changes it, a local DB var is stored as 'transcriber_engine_select' in table 'status'
			const transcriber_engine_select_object = await data_manager.get_local_db_data(
				'transcriber_engine_select',
				'status'
			)
			if (transcriber_engine_select_object) {
				self.target_transcriber = transcriber_engine_select_object.value
			}


	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* Builds the tool by delegating to `tool_common.prototype.build` and then resolving
* the five named component roles from `self.ar_instances`.
*
* Role resolution
* ---------------
* After the generic build populates `self.ar_instances` from `tool_config.ddo_map`,
* each of the following role names is looked up in the ddo_map and matched to the
* corresponding live instance:
*   'media_component'          — component_av (or compatible media player)
*   'transcription_component'  — component_text_area receiving the transcription text
*   'status_user_component'    — component for user-facing workflow status (e.g. mini select)
*   'status_admin_component'   — component for admin-facing workflow status
*   'references_component'     — component listing related references
*
* If a role is not declared in the ontology ddo_map, a warning is logged and that role
* is skipped (the property remains null on self).
*
* Language override
* -----------------
* When `transcription_component.context.options.related_component_lang` is defined and
* differs from the component's current lang, the component is re-built under the correct
* language.  This ensures the transcription text is loaded for the source language even
* when the tool was opened from a component displaying a different translation.
*
* Relation list
* -------------
* After roles are resolved, `self.load_relation_list()` is called to fetch the list of
* parent sections that link to the current transcription record.  The result is stored
* in `self.relation_list` and consumed by `render_tool_transcription` to populate the
* parent-section selector in the toolbar.
*
* @param {boolean} [autoload=false] - When true, fetches the tool's registered context
*   from the API (tool_common.build behaviour).
* @returns {Promise<boolean>} Result from tool_common.prototype.build (true on success).
*/
tool_transcription.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// fix components instances for convenience
			const roles = [
				'media_component',
				'transcription_component',
				'status_user_component',
				'status_admin_component',
				'references_component'
			];
			const roles_length = roles.length
			for (let i = 0; i < roles_length; i++) {

				const role	= roles[i]
				const ddo	= self.tool_config.ddo_map.find(el => el.role===role)
				if (!ddo) {
					console.warn(`Warning: \n\tThe role '${role}' it's not defined in Ontology and will be ignored`);
					continue;
				}
				self[role] = self.ar_instances.find(el => el.tipo===ddo.tipo)

				if(role === 'transcription_component'){
					// force change lang if related_component_lang is defined (original lang)
					// The reset-and-reload lives in common.js rebuild_component_in_lang:
					// build() MEMOIZES, so a bare build(true) after a lang change is a
					// no-op and the editor opens blank. Shared with tool_indexation and
					// tool_lang so the three tools behave identically.
					const original_lang = self.transcription_component.context.options
						? self.transcription_component.context.options.related_component_lang
						: null
					if (await rebuild_component_in_lang(self.transcription_component, original_lang)) {
						// set source lang
						self.source_lang = self.transcription_component.lang
						if(SHOW_DEBUG===true) {
							console.log('Changed transcription_component lang to related_component_lang:', self.transcription_component.lang);
						}
					}
				}
			}

		// relation_list. Load relation_list from API
			// This is used to build a select element to allow
			// user to select the top_section_tipo and top_section_id of current transcription
			self.relation_list = await self.load_relation_list()

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom



/**
* LOAD_RELATION_LIST
* Fetches the list of parent sections that relate to the current transcription record
* via a `related_search` API call on the transcription component.
*
* The API is called with `mode: 'related_list'` and a filter that constrains results
* to the single record identified by the transcription component's own section_tipo and
* section_id.  The `section_tipo: ['all']` SQO parameter requests all section types
* rather than limiting to a specific ontology branch.
*
* The returned datum is stored in `self.relation_list` and later consumed by
* `render_related_list` (in render_tool_transcription.js) to build the parent-section
* `<select>` element in the toolbar.
*
* Datum shape (api_response.result):
* {
*   context : Array  — per-section_tipo label/tipo metadata
*   data    : Array  — flat list of component values keyed by section_tipo + section_id
* }
*
* @returns {Promise<Object>} The API result datum (context + data arrays), or undefined
*   if the API call fails.
*/
tool_transcription.prototype.load_relation_list = async function() {

	const self = this

	const transcription_component = self.transcription_component

	const source = {
		action			: 'related_search',
		model			: transcription_component.model,
		tipo			: transcription_component.tipo,
		section_tipo	: transcription_component.section_tipo,
		section_id		: transcription_component.section_id,
		lang			: transcription_component.lang,
		mode			: 'related_list'
	}

	const sqo = {
		section_tipo		: ['all'],
		mode				: 'related',
		// limit				: 1,
		offset				: 0,
		full_count			: false,
		filter_by_locators	: [{
			section_tipo	: transcription_component.section_tipo,
			section_id		: transcription_component.section_id
		}]
	}

	const rqo = {
		action	: 'read',
		source	: source,
		sqo		: sqo
	}

	// get context and data
		const api_response = await data_manager.request({
			body : rqo
		})

	const datum = response_data(api_response)


	return datum
}//end load_relation_list



/**
* GET_USER_TOOLS
* Queries the dd_tools_api to determine which of the requested tools are accessible
* to the current user.  Used by the render layer to conditionally show optional toolbar
* buttons (e.g. 'tool_time_machine', 'tool_tr_print').
*
* The result array contains one tool_simple_context object per accessible tool, each
* with properties: name, model, label, icon, css, properties, etc.  Tools that the
* user does not have permission to access are omitted from the array entirely.
*
* (!) `create_source(self, 'user_tools')` passes the action name as the second argument
* to generate a source descriptor; the action string itself has no routing significance
* here — only `dd_api: 'dd_tools_api'` and `action: 'user_tools'` in the rqo matter.
*
* @param {Array} ar_requested_tools - Names of tools to check, e.g. ['tool_time_machine']
* @returns {Promise<Array>} Array of tool_simple_context objects for each accessible tool.
*/
tool_transcription.prototype.get_user_tools = async function(ar_requested_tools) {

	const self = this

	// source. Note that second argument is the name of the function is the action that not has utility here
		const source = create_source(self, 'user_tools')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'user_tools',
			source	: source,
			options	: {
				ar_requested_tools : ar_requested_tools
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo
			})
			.then(function(api_response){
				if(SHOW_DEVELOPER===true) {
					dd_console("[tool_transcription.get_user_tools] api_response:",'DEBUG',api_response);
				}

				const result = response_data(api_response) // array of objects

				resolve(result)
			})
		})
}//end get_user_tools



/**
* BUILD_SUBTITLES_FILE
* Call to API to calculate current subtitles from the transcription
* and save it to a normalized file path like '/httpdocs/dedalo/media/av/subtitles/rsc35_rsc167_1_lg-spa.vtt'
* @see Note that component_av (in view 'player') is subscribed to event 'updated_subtitles_file_' + self.id
* and must be publish the change to force the load of new file in the player captions track
*
* The server-side handler reads the transcription component's stored value, parses the
* Dédalo timecode tag format (`[TC_HH:MM:SS.mmm_TC]`), wraps each paragraph as a WebVTT
* cue, and writes the file under the canonical media path.
*
* `max_charline` controls subtitle line-wrapping width (characters per line); the value
* is read from `self.characters_per_line`, which is set by the characters-per-line input
* in the render layer and persisted in localStorage as 'subtitles_characters_per_line'.
*
* The request uses `key: 0` to target the first (and only) datum item of the
* transcription component — multi-item transcription components are not supported.
*
* Timeout is extended to 120 seconds; subtitle generation on long recordings may require
* server-side parsing of large HTML strings.
*
* @returns {Promise<Object>} API response shape:
*   {
*     result : {boolean}  — true on success
*     url    : {string}   — absolute URL of the generated .vtt file
*     msg    : {string}   — human-readable status or error description
*   }
*/
tool_transcription.prototype.build_subtitles_file = async function() {

	const self = this

	// short vars
		const component_text_area	= self.transcription_component // component_text_area instance
		const lang					= component_text_area.data.lang // !important : get from data, not from context
		const max_charline			= self.characters_per_line // fixed from input 'input_characters_per_line'

	// source. Note that second argument is the name of the function is the action that not has utility here
		const source = create_source(self, 'build_subtitles_file')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				component_tipo	: component_text_area.tipo,
				section_tipo	: component_text_area.section_tipo,
				section_id		: component_text_area.section_id,
				lang			: lang,
				max_charline	: max_charline,
				key				: 0	// fixed component dato key as zero
			}
		}

	// call to the API, fetch data and get response
	return new Promise(function(resolve){

		data_manager.request({
			body : rqo,
			retries : 1, // one try only
			timeout : 120 * 1000 // 120 secs waiting response
		})
		.then(function(response){
			if(SHOW_DEVELOPER===true) {
				dd_console("-> build_subtitles_file API response:",'DEBUG', response);
			}

			resolve(response)
		})
	});
}//end build_subtitles_file



/**
* SEND_UNLOAD_CLEANUP
* The ONE keepalive request automatic_transcription's page_cleanup sends when the
* tool window closes mid-job (deleting the throwaway server-side WAV).
* `data_manager` cannot be trusted during unload, so this is a bare `keepalive`
* fetch — the one request shape browsers promise to finish after the page is
* gone; the CSRF token rides along (SEC-008).
*
* THE PAGE-IDENTITY LATCH (LEAD-2): a raw fetch is a transport of its own, so it
* asks error_dispatch.refused_by_page_identity first. A page whose identity was
* revoked is unloading INTO the reload the latch asked for — its cleanup is the
* previous user's, and must not run under the new session. Module-level (not a
* closure of the run) so the client suite measures that outcome
* (test_relogin_identity case s2).
* @param {Object} body - the tool_request RQO
* @return {boolean} true when the request was handed to fetch
*/
export const send_unload_cleanup = function(body) {

	if (refused_by_page_identity(body)) {
		return false
	}

	const csrf = (typeof page_globals!=='undefined' && page_globals.csrf_token)
		? page_globals.csrf_token
		: null
	fetch('/dedalo/core/api/v1/json/', {
		method		: 'POST',
		credentials	: 'same-origin',
		keepalive	: true,
		headers		: csrf
			? { 'Content-Type': 'application/json', 'X-Dedalo-Csrf-Token': csrf }
			: { 'Content-Type': 'application/json' },
		body		: JSON.stringify(body)
	})
	return true
}//end send_unload_cleanup



/**
* AUTOMATIC_TRANSCRIPTION
* Transcribe the record's audio IN THE BROWSER and return the text ready for the
* transcription component.
*
* The audio never leaves the machine: the server only extracts a 16 kHz mono WAV
* from the media original, and every step after that happens here. That is what
* makes the tool usable on interviews holding personal data, in institutions with
* no cloud contract and often no outbound internet at all.
*
* The flow:
*   1. ask the server for the transcribable WAV (`create_transcribable_audio_file`);
*   2. fetch it, decode it at 16 kHz through the Web Audio API and TRANSFER the
*      samples to the worker (transferring, not copying — a 90-minute interview is
*      ~350 MB of float samples and copying it doubles that for no reason);
*   3. let the worker plan speech windows, transcribe them and report progress;
*   4. format the result into paragraphs (lib/paragraphs.js) and resolve;
*   5. delete the throwaway WAV — on EVERY exit path, including failure and cancel.
*
* Partial results are written to IndexedDB as they arrive, so closing the window
* mid-job no longer throws the work away: the next run resumes from where it got to.
*
* (!) Status output uses textContent throughout: worker output is recognised
* speech and may contain HTML characters (SEC-031).
*
* @param {Object} options
* @param {string} options.transcriber_quality - model id from the catalog
* @param {string} options.source_lang - Dédalo lang tag ('lg-spa'), mapped to ISO 639-1 here
* @param {Object} [options.format_options] - paragraph/timecode options (lib/paragraphs.js)
* @param {Object} [options.decode] - decoding overrides (lib/browser_whisper DEFAULT_DECODE)
* @param {string} [options.device] - 'auto' (default) | 'webgpu' | 'wasm'
* @param {Object} options.nodes - DOM nodes held by the render layer:
*   nodes.status_panel, nodes.button_automatic_transcription
* @returns {Promise<Array>} single-element array with the HTML for component_text_area
*/
tool_transcription.prototype.automatic_transcription = async function(options) {

	const self = this

	// options
		const transcriber_quality	= options.transcriber_quality
		const nodes					= options.nodes
		const source_lang			= options.source_lang // self.transcription_component.lang
		const format_options		= options.format_options || {}

	// The key partial results are stored under (partial_id — ONE spelling, shared
	// with the render layer, which reads the same store to announce an
	// interrupted run before the button is pressed).
		const resume_id = partial_id( self )

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'create_transcribable_audio_file')

		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				media_ddo : {
					component_tipo		: self.media_component.tipo,
					section_id			: self.media_component.section_id,
					section_tipo		: self.media_component.section_tipo
				}
			}
		}

	/**
	* PANEL
	* The one voice. `set_status`/`set_error` as they were are gone: set_error wrote
	* into a node whose `hide` class it never removed, so every failure raised before
	* the run started — a failed audio conversion, a missing model, an empty store —
	* was invisible by construction. Everything below routes through the panel
	* (render_transcription_status.js), which cannot hide a report.
	*/
		const panel = nodes.status_panel

	/**
	* SAVE_PARTIAL
	* Write THIS model's slot of the resume store, leaving every other model's
	* alone. `undefined` segments retire this model's slot (the run finished).
	*
	* Read-modify-write, per window. The alternative — keeping the whole record in
	* a closure and writing it back — would let a run started in a second tool
	* window silently erase the first window's slots, and two transcriptions of
	* the same record open at once is a normal working pattern here.
	*
	* @param {Array|undefined} segments
	*/
		const save_partial = async function( segments ) {

			const stored	= await data_manager.get_local_db_data( resume_id, 'status' )
			const partials	= read_partials( stored )
			const now		= Date.now()

			if (Array.isArray(segments) && segments.length>0) {
				partials[transcriber_quality] = { segments: segments, updated: now }
			} else {
				delete partials[transcriber_quality]
			}

			// A partial is recognised speech from an interrupted run; past
			// PARTIAL_MAX_AGE the recording has moved on and splicing it into new
			// work would be worse than starting over. Dropped on write, so the
			// store cannot grow a slot per model forever.
			for (const model in partials) {
				const updated = partials[model].updated || 0
				if (updated>0 && (now - updated)>PARTIAL_MAX_AGE) {
					delete partials[model]
				}
			}

			data_manager.set_local_db_data({
				id			: resume_id,
				partials	: partials,
				updated		: now
			}, 'status')
		}

	/**
	* UNLOAD GUARDS
	* A browser run lives in THIS tab: a reload or a close kills the worker
	* mid-window, and until now nothing said so — the global unsaved-data guard
	* (client/dedalo/core/common/js/events.js) is commented out, so an archivist
	* could throw away an hour of transcription with ⌘R and no dialog.
	*
	* Armed only while a browser run is actually in flight, and disarmed by every
	* exit path (see end_run, which every one of them reaches). The SERVER engine
	* deliberately gets no guard: that job runs on the transcriber and a reload
	* re-polls it (get_server_status), so warning about it would be a lie.
	*
	* (!) The browser ignores any custom text and shows its own wording, so there
	* is no label here to translate — `preventDefault` IS the whole API.
	*/
		const guard_unload = function( e ) {
			e.preventDefault()
			e.returnValue = '' // Safari and older Chrome still read this
			return ''
		}
		const arm_unload_guard = function() {
			window.addEventListener('beforeunload', guard_unload)
		}
		const disarm_unload_guard = function() {
			window.removeEventListener('beforeunload', guard_unload)
		}

	/**
	* END_RUN
	* A reported failure ends the run: retire the percentage line (an empty
	* progress hides it — clear() would also drop the warnings this run
	* accumulated, and those must survive) and give the trigger back.
	*/
		const end_run = function() {
			disarm_unload_guard()
			panel.progress('')
			if (nodes.button_automatic_transcription) {
				nodes.button_automatic_transcription.classList.remove('disable')
				// The spinner is set when the button is pressed; every path that
				// gives the button back must also stop it, or a failed run leaves
				// the trigger spinning over a panel that says it already failed.
				ui.set_button_busy( nodes.button_automatic_transcription, false )
			}
		}

	/**
	* A RUN ATTEMPT STARTS HERE — so the standing messages are dropped HERE.
	*
	* They used to be cleared only once a run had PASSED preflight, which meant a
	* refusal (an unusable model, an empty store, a failed audio conversion) piled
	* one identical error block on top of another every time the button was
	* pressed: the panel grew a wall of the same sentence and the newest report was
	* the least visible thing in it.
	*
	* GUARDED, because clearing is destructive: a run still in progress has
	* accumulated warnings that must survive to its end (a CPU fallback, a skipped
	* fragment). A live worker IS a run in progress, so its messages are left alone.
	*/
		if (!self.transcribe_worker) {
			panel.clear()
		}

	/**
	* SET_STATUS
	* The transient line: percentages and live tokens, overwritten, never stacked.
	* Plain text throughout — worker output is recognised speech (SEC-031).
	*/
		const set_status = function(text) {
			panel.progress( text )
		}

	/**
	* SET_ERROR
	* A RUNTIME failure in the engine's own words: classified into a message, a
	* cause and a pressable remedy, with the raw text kept in the detail
	* disclosure. Use set_message instead when the text is already a truthful
	* sentence (a server `msg`), which classification would only overwrite.
	*/
		const set_error = function(message, context) {
			panel.fail( message, Object.assign({ model: transcriber_quality }, context || {}) )
			end_run()
		}

	/**
	* SET_MESSAGE
	* A failure whose message is ALREADY the truth — the server's own `msg`, or a
	* refusal this code composed. Reported verbatim, with its remedy when one
	* exists; passing it through the classifier would replace it with the generic
	* "The transcription failed" and bury the real sentence in the detail.
	*/
		const set_message = function(message, options) {
			const info = options || {}
			panel.report({
				phase		: info.phase || 'preflight',
				severity	: 'error',
				message		: message,
				cause		: info.cause || '',
				action		: info.action || '',
				action_key	: info.action_key,
				// The model the remedy is FOR. Without it the panel falls back to
				// whatever the picker holds when the button is finally pressed — which
				// is how a remedy came to act on a model it was never offered for.
				action_model: info.action_model,
				detail		: info.detail || ''
			})
			console.error('[tool_transcription]', message);
			end_run()
		}

	/**
	* PAGE_CLEANUP
	* Delete the server-side WAV when the tool WINDOW is closed mid-job.
	*
	* Every in-page exit path calls delete_audio below — but a closed tab runs
	* none of them, and the interview audio would sit on the server until someone
	* re-ran and completed a transcription of the same record. `data_manager`
	* cannot be trusted during unload (its promise machinery may never run), so
	* this is a bare `keepalive` fetch: the one request shape browsers promise to
	* finish after the page is gone. Best-effort by nature; the CSRF token rides
	* along because the API requires it (SEC-008).
	*/
		const page_cleanup = function() {
			try {
				send_unload_cleanup({
					dd_api	: 'dd_tools_api',
					action	: 'tool_request',
					source	: create_source(self, 'delete_transcribable_audio_file'),
					options	: rqo.options
				})
			} catch (error) {
				// the tab is going away; nothing left to report to
			}
		}

	/**
	* DELETE_AUDIO
	* Remove the server-side throwaway WAV.
	*
	* This is deliberately called on EVERY exit path. It used to run only on
	* success, which left a copy of the interview audio on disk after any error,
	* cancel or closed tab — the one file in this flow that must not linger.
	*/
		const delete_audio = function() {
			// the in-page exit ran; the unload hooks are no longer needed. BOTH of
			// them: `finish` resolves straight to the caller on the success path
			// without passing through end_run, so a guard disarmed only there
			// would outlive the run and warn on every later reload.
			window.removeEventListener('pagehide', page_cleanup)
			disarm_unload_guard()

			const cleanup_rqo = {
				dd_api	: 'dd_tools_api',
				action	: 'tool_request',
				source	: create_source(self, 'delete_transcribable_audio_file'),
				options	: rqo.options
			}
			// housekeeping, so the answer is READ and logged, not surfaced: a
			// leftover temporary file is the server's to sweep, and the operator
			// can do nothing about it. (data_manager.request never rejects on an
			// envelope failure — a `.catch` here read nothing.)
			data_manager.request({
				body	: cleanup_rqo,
				retries	: 1,
				timeout	: 3600 * 1000
			})
			.then(function(api_response){
				if (request_failed(api_response)) {
					console.error('[tool_transcription] could not delete the temporary audio file:', api_response.error);
				}
			})
		}

	// Server-side audio preparation. Long, because a large video has to be
	// re-encoded before anything can be transcribed.
	//
	// SAID BEFORE IT IS WAITED FOR. This is the FIRST thing the run does and on a
	// long interview it is minutes of re-encoding — and until now the panel said
	// nothing for all of it: the only sign the tool had accepted the press was the
	// spinner on the trigger, which says "busy" without saying at what. The first
	// word the panel spoke was "Processing audio…", and it was not spoken until the
	// WAV already existed. A phase that long has to name itself while it runs.
		set_status( self.get_tool_label('preparing_audio') || 'Preparing the audio file...' )

		const response = await data_manager.request({
			body	: rqo,
			retries	: 1, // one try only
			timeout	: 3600 * 1000 // 3600 secs waiting response
		})
		if(SHOW_DEVELOPER===true) {
			dd_console("-> transcription_component API response:",'DEBUG',response);
		}
		// envelope v2: the payload is the media URL of the prepared WAV; a refusal
		// carries the coded, translated error and no payload at all.
		const audio_url = request_failed(response) ? null : response_data(response)
		if (!audio_url) {
			set_message(
				(request_failed(response) ? error_text(response.error) : '')
					|| self.get_tool_label('error_audio_conversion')
					|| 'The recording could not be prepared for transcription',
				{ phase: 'audio' }
			)
			return false
		}
		// From here a WAV of the interview exists on the server: arm the unload
		// hook so even a closed window deletes it.
		window.addEventListener('pagehide', page_cleanup)

	// Map the Dédalo lang tag ('lg-spa') to the ISO 639-1 code ('es') the model
	// takes as its language hint.
		const json_langs	= self.json_langs || await get_json_langs() || []
		const lang_obj		= json_langs.find(item => item.dd_lang===source_lang)
		const lang			= lang_obj ? lang_obj.tld2 : 'en'
		if (json_langs.length<1) {
			console.error('Error. Expected array of json_langs but empty result is obtained :', json_langs);
		}
		if(SHOW_DEBUG===true) {
			console.log('Automatic_transcription source lang:', lang);
		}

	// Where the browser may load the model from. The browser cannot read the
	// install's configuration, so it asks: the store URL, whether a public hub is
	// permitted (normally NOT — these are personal recordings), and whether the
	// store actually holds anything. Without that last fact a missing model fails
	// as an opaque 404 from inside the ONNX runtime.
		const sources_response	= await self.get_model_sources()
		const sources			= response_data(sources_response)
			|| { model_host: '/dedalo/ai_models/', allow_hub: false, store_ready: true }

		// Refuse EARLY and specifically when the chosen model cannot run.
		// Left to the runtime, this fails as "Could not locate file: …/config.json"
		// from inside the ONNX loader — after the audio has been prepared, and with
		// a message that names neither the model nor what to do about it.
		// `installed` ABSENT = this server cannot tell (allow, as before); an EMPTY
		// array is a real answer: nothing is installed. The one law, from
		// transcription_report.js — never re-derived here.
		const model_ready	= installed_answer( sources, transcriber_quality )!=='no'

		if (sources.allow_hub!==true && (sources.store_ready===false || !model_ready)) {

			// WHY the state and not just `installed`: a DAMAGED model is absent from
			// `installed` too, and announcing it as "not installed" sent the
			// archivist to a Download the server refuses as "already installed"
			// (the files ARE there — broken). The state table is the one authority,
			// shared with the readiness line (MODEL_STATES).
			// A null state (a server that cannot say) or a state this table has not
			// learned yet (a server one version ahead) both keep the coarse message:
			// we do not invent a verdict from a word we cannot read.
			const model_state	= model_state_of( sources.models, transcriber_quality )
			const state_info	= model_state ? (MODEL_STATES[model_state] || null) : null

			if (sources.store_ready===false) {
				set_message(
					self.get_tool_label('model_store_empty')
						|| 'No local speech models are installed. Ask your administrator to seed the model store (scripts/fetch_ai_models.ts).',
					{ phase: 'model' }
				)
			} else if (state_info && state_info.action_key==='action_repair_model') {
				// damaged / incomplete: the files ARE there and downloading them
				// again is not what fixes it — repairing is.
				set_message(
					self.get_tool_label(state_info.message_key)
						|| 'The speech model on this server is damaged',
					{
						phase		: 'model',
						cause		: self.get_tool_label(state_info.cause_key)
							|| 'Its files are incomplete or corrupted — usually an interrupted download.',
						action		: self.get_tool_label(state_info.action_key) || 'Repair the model',
						action_key	: state_info.action_key,
						action_model: transcriber_quality,
						detail		: `model: ${transcriber_quality}\nstate: ${model_state}`
					}
				)
			} else {
				set_message(
					`${self.get_tool_label('model_not_installed') || 'This model is not installed on this server'}: ${transcriber_quality}`,
					{
						phase		: 'model',
						action		: self.get_tool_label('action_download_model') || 'Download the model',
						action_key	: 'action_download_model',
						action_model: transcriber_quality
					}
				)
			}
			delete_audio()
			return false
		}

	// Anything already transcribed in a previous, interrupted run — THIS model's
	// slot. Another model's partial is left exactly where it is: the readiness
	// line offered the choice before this point (see refresh_readiness), and a
	// run that was not told to take it does not get to destroy it.
		const stored_partials	= read_partials( await data_manager.get_local_db_data( resume_id, 'status' ) )
		const resume			= stored_partials[transcriber_quality] || null

	// The worker. Held on the instance so the cancel button can reach it.
		const transcribe_worker = new Worker(
			'../../tools/tool_transcription/transcribers/browser_whisper/browser_whisper.js',
			{ type : 'module' }
		)
		self.transcribe_worker = transcribe_worker
		// From here there is work in this tab that no server holds a copy of.
		arm_unload_guard()

	return new Promise(async function(resolve){

		// The standing messages were already dropped at the START of this attempt
		// (see the guarded panel.clear above): clearing again here would discard
		// anything this run has reported since — and left the refusals of a run
		// that never got this far standing on top of each other.
		set_status( self.get_tool_label('processing_audio') || 'Processing audio...' )

		let speech_seconds = 0

		/**
		* FINISH
		* The single exit: stop the worker, delete the audio, drop the saved
		* partial and hand the formatted text back. Written once so no path can
		* forget the clean-up.
		*
		* AN EMPTY RESULT NEVER BECOMES A VALUE. With no segments — a cancel before
		* the first window finished, or a recording in which the detector found no
		* speech — resolving [''] would make the caller set_value('') and SAVE,
		* silently erasing whatever transcript the component already held. Nothing
		* recognised means nothing to write, and the run reports why instead.
		*/
		const finish = function(segments) {

			transcribe_worker.terminate()
			self.transcribe_worker = null
			delete_audio()
			// ONLY THIS RUN'S SLOT. A finished `small` run has no business
			// clearing the hour of `medium` waiting in the next slot — it did not
			// produce it and the archivist was never asked.
			save_partial( undefined )

			if (!Array.isArray(segments) || segments.length===0) {
				// A WARNING, not an error: nothing failed — there was simply no
				// speech, and the existing text was deliberately left alone.
				panel.report({
					phase		: 'done',
					severity	: 'warning',
					message		: self.get_tool_label('no_speech_recognized')
						|| 'No speech was recognized — the existing text was left untouched.'
				})
				end_run()
				resolve( false )
				return
			}

			// Speaker detection ran? Every detected turn is opened with a
			// PLACEHOLDER person tag (P1, P2, … — empty data payload =
			// unresolved) and the text saves IMMEDIATELY: turn marking is
			// mechanical, identity is not. The archivist reviews/corrects the
			// tags in the editor like any content, then binds identities
			// whenever they want with "Assign speakers" (assign_speakers) —
			// a deterministic tag swap through the normal save path.
			const has_speakers = segments.some( segment => segment.speaker!==undefined )
			if (has_speakers) {
				const speaker_order = []
				for (const segment of segments) {
					if (segment.speaker!==undefined && !speaker_order.includes(segment.speaker)) {
						speaker_order.push( segment.speaker )
					}
				}
				const speaker_tags = {}
				for (let i = 0; i < speaker_order.length; i++) {
					speaker_tags[speaker_order[i]] = build_placeholder_tag( i + 1 )
				}
				resolve([ segments_to_html( segments, Object.assign({}, format_options, {
					speaker_prefix	: false, // numeric ids never leak into the text
					speaker_tags	: speaker_tags
				}) ) ])
				return
			}

			resolve([ segments_to_html( segments, format_options ) ])
		}

		transcribe_worker.onmessage = function(e) {

			const status	= e.data.status
			const data		= e.data.data

			switch (status) {

				// Model download / compilation.
				case 'init': {
					const label = data.status==='ready'
						? self.get_tool_label( data.device==='webgpu' ? 'setting_up' : 'procesing' )
						: self.get_tool_label( 'initializing' )
					const loaded = (data.progress)
						? ` : ${parseInt(data.progress).toString().padStart(2, 0)}%`
						: (data.status==='ready' ? '' : ' : 00%')
					set_status( `${label}${loaded}` )
					break;
				}

				// The window plan: from here on there is a real denominator for
				// progress, instead of "still working".
				case 'plan':
					speech_seconds = data.speech_seconds
					break;

				case 'window_start': {
					const percent = speech_seconds>0
						? Math.min( 99, Math.round((data.done_seconds / speech_seconds) * 100) )
						: 0
					set_status( `${self.get_tool_label('procesing') || 'Processing'} : ${percent}%` )
					break;
				}

				// Live tokens while a window is decoded (greedy decoding only).
				case 'partial':
					// SEC-031: worker output is recognised speech; text only.
					// The panel's progress line is a text node by construction.
					set_status( data.text )
					break;

				// A window finished: persist so a closed tab can resume.
				case 'progress':
					save_partial( data.segments )
					break;

				// Speaker detection (after the last window): its own progress line.
				case 'diarize_init': {
					const label = self.get_tool_label('detecting_speakers') || 'Detecting speakers'
					const loaded = data.progress ? ` : ${parseInt(data.progress).toString().padStart(2, 0)}%` : ''
					set_status( `${label}${loaded}` )
					break;
				}

				case 'diarize_progress': {
					const percent = data.duration>0
						? Math.min( 99, Math.round((data.done_seconds / data.duration) * 100) )
						: 0
					set_status( `${self.get_tool_label('detecting_speakers') || 'Detecting speakers'} : ${percent}%` )
					break;
				}

				// A degradation, not a failure: the run continues and the user must
				// still be told when it finishes (warnings accumulate; progress does
				// not, so this can never be a progress line — it would be overwritten
				// by the next percentage and the user would never see it).
				case 'warning': {
					// The label wins over the worker's own message exactly as before —
					// this only fills in a `{count}` the label's text may carry (e.g.
					// "N fragments … were skipped"). A label with no placeholder is
					// untouched: String.replace is a no-op when the pattern is absent,
					// so the CPU-fallback warning renders exactly as it did before.
					// The count is worker-reported data, not markup — it goes into the
					// message text only, which render_report writes via textContent
					// (SEC-031: no HTML path is opened by this substitution).
					const label = self.get_tool_label(data.label_key) || data.message || ''
					const message = (typeof data.count==='number')
						? label.replace('{count}', String(data.count))
						: label
					panel.report({
						phase		: data.phase || 'transcribe',
						severity	: 'warning',
						message		: message,
						detail		: data.detail || ''
					})
					break;
				}

				// Best-effort: the transcript arrives without speakers; say so.
				case 'diarize_error':
					console.warn('[tool_transcription] speaker detection failed:', data.message);
					panel.report({
						phase		: 'speakers',
						severity	: 'warning',
						message		: self.get_tool_label('speaker_detection_failed')
							|| 'Speaker detection failed — the transcription continues without speaker tags.',
						detail		: data.message || ''
					})
					break;

				case 'end':
					finish( data.segments )
					break;

				case 'error':
					transcribe_worker.terminate()
					self.transcribe_worker = null
					delete_audio()
					set_error( data.message, {
						phase	: data.phase || 'transcribe',
						device	: data.device,
						log		: data.log
					})
					resolve( false )
					break;
			}
		}

		transcribe_worker.onerror = function(e) {
			transcribe_worker.terminate()
			self.transcribe_worker = null
			delete_audio()
			// A module worker that fails to LOAD raises an ErrorEvent with an empty
			// `message`: classification then falls through to the generic failure
			// with nothing in the technical detail — less than the console line this
			// replaced. The file and line are what identify a load failure, so they
			// go into the detail, always.
			const where = [
				e.filename ? `file: ${e.filename}` : '',
				(typeof e.lineno==='number' && e.lineno>0) ? `line: ${e.lineno}` : ''
			].filter(Boolean).join('\n')
			set_error( e.message || '', {
				phase	: 'transcribe',
				device	: options.device || 'auto',
				log		: where
			})
			resolve( false )
		}

		try {
			// Decode to exactly 16 kHz mono — Whisper's only accepted input rate.
			// AudioContext is unavailable inside a Worker, so this must happen here.
			const audio_buffer	= await fetch_audio( audio_url );
			const audio_ctx		= new AudioContext({ sampleRate: 16000 });
			let audio_data
			try {
				audio_data = await audio_ctx.decodeAudioData(audio_buffer);
			} finally {
				// Close the context IMMEDIATELY: the decoded AudioBuffer outlives it,
				// and browsers cap live AudioContexts per page (Chrome: 6) — without
				// this, the sixth transcription in the same tool window fails to
				// construct one at all.
				audio_ctx.close().catch(function(){ /* already closed */ })
			}
			const audio_chanel	= audio_data.getChannelData(0)

			transcribe_worker.postMessage(
				{
					action	: 'transcribe',
					options	: {
						audio			: audio_chanel,
						sample_rate		: 16000,
						language		: lang,
						model			: transcriber_quality,
						device			: options.device || 'auto',
						dtype			: options.dtype,
						decode			: options.decode,
						sources			: sources,
						// Speaker detection: the pyannote segmentation model from the
						// SAME local store — set only when the archivist asked for it
						// and the model is installed (the render layer checked).
						diarize			: options.detect_speakers || undefined,
						resume_segments	: resume ? resume.segments : undefined,
						resume_seconds	: resume ? resume_seconds_of( resume.segments ) : 0
					}
				},
				// Transfer the samples instead of copying them: for a long
				// interview the copy alone can exhaust the tab's memory.
				[ audio_chanel.buffer ]
			);
		} catch (error) {
			transcribe_worker.terminate()
			self.transcribe_worker = null
			delete_audio()
			set_error( error.message, { phase: 'audio' } )
			resolve( false )
		}
	});

}//end automatic_transcription



/**
* FETCH_AUDIO
* Read the speech-recognition audio the server just prepared.
*
* THE WEB SERVER SERVES THESE BYTES, never the engine. Installs hold single AV
* files of 16-32 GB, so the media path must stay Apache/nginx `sendfile` with
* Range intact — engineering/MEDIA_PROTECTION.md §1: "never put an application
* process in the media-serving path". A logged-in user already carries the
* `dedalo_media_auth` cookie (Rule A), which is what authorises this read.
*
* The one requirement that follows: the media base must be reachable from the
* application's own page. Same origin is the production layout and needs nothing;
* a media host on a DIFFERENT origin (a separate Apache/CDN, or a dev box with
* the app on one port and media on another) must send CORS headers for the app's
* origin, or the browser refuses the read — the same restriction that makes a
* subtitle track fail with "Domains, protocols and ports must match". The error
* below says so, because the raw failure is an unexplained "Failed to fetch".
*
* @param {string} url - the media URL returned by create_transcribable_audio_file
* @returns {Promise<ArrayBuffer>} the raw audio bytes
*/
const fetch_audio = async function( url ) {

	let response
	try {
		response = await fetch( url, { credentials: 'include' } )
	} catch (error) {
		throw new Error(
			`the audio file could not be read from ${url} (${error.message}). `
			+ 'If the media server is on another host or port than the application, it must allow '
			+ "cross-origin reads from this page's origin."
		)
	}

	if (!response.ok) {
		throw new Error(`the audio file could not be read (HTTP ${response.status}) from ${url}`)
	}

	return await response.arrayBuffer()
}//end fetch_audio



/**
* RESUME_SECONDS_OF
* How far a saved partial transcript reached — the point the worker resumes from.
*
* The end of the last segment, not the count of segments: windows are planned on
* the audio timeline, so seconds are the only meaningful cursor.
*
* Exported: the readiness line states the SAME cursor the worker will resume
* from, so "reached 42:15" and where it actually restarts cannot disagree.
*
* @param {Array} segments
* @returns {number} seconds
*/
export const resume_seconds_of = function( segments ) {

	if (!Array.isArray(segments) || segments.length===0) {
		return 0
	}

	const last = segments[segments.length - 1]

	return (typeof last.end==='number')
		? last.end
		: (typeof last.start==='number' ? last.start : 0)
}//end resume_seconds_of



/**
* PARTIAL_ID
* The ONE spelling of the resume key. Per record AND per component, so two
* transcriptions open at once never overwrite each other's progress.
*
* Exported because the render layer reads the same store to state, before the
* button is pressed, that an interrupted run is waiting — and two spellings of
* one key is a store that silently never matches.
*
* @param {Object} self - the tool_transcription instance
* @returns {string}
*/
export const partial_id = function( self ) {

	// THE PRINCIPAL IS PART OF THE KEY (P2-3 / CLI-08).
	//
	// What this store holds is the raw ASR output: recognised speech, speaker
	// turns and timecodes — exactly the personal-data and embargoed material a
	// heritage archive exists to protect. It was keyed by RECORD and COMPONENT
	// only, so on a shared reading-room workstation the NEXT user could read a
	// colleague's interview transcript out of DevTools from the login page, or
	// open the tool and be offered `action_resume` on someone else's work.
	//
	// `menu.build_cache_id` applies exactly this rule one directory away, and
	// reads the same global. An empty user id yields 'anon', which is a DIFFERENT
	// namespace from any logged user rather than a shared one — a key that
	// collapses to the record when the id is missing is the original defect
	// wearing a suffix.
	const globals = window.page_globals || {}
	const user_id = globals.user_id || 'anon'

	return 'transcription_partial_'
		+ user_id + '_'
		+ self.media_component.section_tipo + '_'
		+ self.media_component.section_id + '_'
		+ self.transcription_component.tipo
}//end partial_id



/**
* How old a saved partial may be and still be offered, in ms. A partial is
* recognised speech from a run that was interrupted; after a fortnight the
* recording has almost certainly moved on and resuming from it would splice old
* text into new work.
*/
export const PARTIAL_MAX_AGE = 14 * 24 * 3600 * 1000



/**
* READ_PARTIALS
* The saved partials, ONE SLOT PER MODEL, as `{[model]: {segments, updated}}`.
*
* (!) PER MODEL, and this is the whole point of the shape. The store used to be a
* single slot — `{segments, model}` — and the resume was gated on
* `saved.model===selected`, which read as "a partial from another model is
* ignored". It was worse than ignored: the next run's FIRST completed window
* overwrote that one slot, so an hour of work under `small` was destroyed by
* window one of a `medium` run, before anything could ask. A slot per model means
* the two coexist and the choice stays the archivist's.
*
* Legacy records (the single slot) are migrated on read, so an interrupted run
* from before this change is still offered.
*
* @param {Object} stored - the raw local_db record, or null
* @returns {Object} model → {segments, updated}; empty when there is nothing
*/
export const read_partials = function( stored ) {

	if (!stored) {
		return {}
	}

	// the current shape
	if (stored.partials && typeof stored.partials==='object') {
		const out = {}
		for (const model in stored.partials) {
			const entry = stored.partials[model]
			if (entry && Array.isArray(entry.segments) && entry.segments.length>0) {
				out[model] = entry
			}
		}
		return out
	}

	// the legacy single slot
	if (typeof stored.model==='string' && stored.model!=='' && Array.isArray(stored.segments) && stored.segments.length>0) {
		return {
			[stored.model] : { segments: stored.segments, updated: stored.updated || 0 }
		}
	}


	return {}
}//end read_partials



/**
* GET_MODEL_SOURCES
* Ask the server where in-browser models may be loaded from.
*
* The answer is install configuration the browser is about to act on: the model
* store URL, whether falling back to a public model hub is allowed (off by
* default — the recordings are personal data and an air-gapped archive must
* work), and whether the store has been seeded at all.
*
* @returns {Promise<Object>} { result: { model_host, allow_hub, store_ready } }
*/
tool_transcription.prototype.get_model_sources = async function() {

	const self = this

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: create_source(self, 'get_model_sources'),
		options	: {}
	}

	try {
		return await data_manager.request({ body: rqo, retries: 1 })
	} catch (error) {
		console.error('[tool_transcription] could not read the model sources:', error);
		return false
	}
}//end get_model_sources



/**
* DOWNLOAD_MODEL
* Ask the server to download one catalog model into the install's own store.
*
* Admin-gated and validated SERVER-side (global admin, catalog names only); the
* download runs as a background job there. The caller polls get_model_sources
* until the model shows up in `installed`.
*
* @param {string} model - catalog model id (e.g. 'onnx-community/whisper-medium-ONNX')
* @returns {Promise<Object|false>} the API response, or false on transport failure
*/
tool_transcription.prototype.download_model = async function( model ) {

	const self = this

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: create_source(self, 'download_model'),
		options	: { model: model }
	}

	try {
		return await data_manager.request({ body: rqo, retries: 1 })
	} catch (error) {
		console.error('[tool_transcription] could not start the model download:', error);
		return false
	}
}//end download_model



/**
* REPAIR_MODEL
* Ask the server to discard the failing files of one catalog model and fetch them
* again. Admin-gated and catalog-bound SERVER-side; the work runs as a background
* job there and the caller polls get_model_sources exactly as a download does.
*
* @param {string} model - catalog model id
* @returns {Promise<Object|false>} the API response, or false on transport failure
*/
tool_transcription.prototype.repair_model = async function( model ) {

	const self = this

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: create_source(self, 'repair_model'),
		options	: { model: model }
	}

	try {
		return await data_manager.request({ body: rqo, retries: 1 })
	} catch (error) {
		console.error('[tool_transcription] could not start the model repair:', error);
		return false
	}
}//end repair_model



/**
* VERIFY_MODEL
* Ask the server to check one model's files against the hub's published lengths
* and record the result, turning an `unverified` model into `ready` or
* `incomplete`. Admin-gated; an install with no outbound internet gets a clean
* refusal rather than a false verdict.
*
* @param {string} model - catalog model id
* @returns {Promise<Object|false>} the API response, or false on transport failure
*/
tool_transcription.prototype.verify_model = async function( model ) {

	const self = this

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: create_source(self, 'verify_model'),
		options	: { model: model }
	}

	try {
		return await data_manager.request({ body: rqo, retries: 1 })
	} catch (error) {
		console.error('[tool_transcription] could not verify the model:', error);
		return false
	}
}//end verify_model



/**
* GET_BACKGROUND_JOB_STATUS
* How is the download / repair job doing?
*
* `get_background_job_status` is a FRAMEWORK action the dispatcher serves for
* every tool (src/core/tools/job_status.ts), scoped to this tool and to the
* requesting user. It is what makes a FAILED job distinguishable from one that is
* merely slow: without it a repair that could not reach the hub left the panel's
* "Downloading the model…" line standing forever, because the only other signal —
* the store's state — looks identical in both cases.
*
* @param {string} job_id - the handle returned by download_model / repair_model
* @returns {Promise<Object|false>} the API response ({job:{status,error,response}}),
*                                  or false on transport failure
*/
tool_transcription.prototype.get_background_job_status = async function( job_id ) {

	const self = this

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: create_source(self, 'get_background_job_status'),
		options	: { background_job_id: job_id }
	}

	try {
		return await data_manager.request({ body: rqo, retries: 1 })
	} catch (error) {
		console.error('[tool_transcription] could not read the background job status:', error);
		return false
	}
}//end get_background_job_status



/**
* SAVE_TRANSCRIPTION
* Persist an automatic-transcription result as THE transcription of the
* component's current language: always item id 1, replacing whatever it held.
*
* This deliberately does NOT go through set_value(0, …): that helper derives
* the target item from `self.data.entries` — the tab's transient state, which
* after an hour of inference can be stale or empty. When it was, the save went
* out id-less, the server (faithfully to the shared-id slice semantics)
* appended a NEW item with a minted id, and the editor — bound to item 1 —
* showed nothing while the transcript sat in item 2 (live: rsc167/528,
* 2026-07-28). A transcription is by contract the lang's single main text, so
* the tool STATES the slot instead of deriving it.
*
* @param {string} html - the TC-tagged paragraph HTML for component_text_area
* @returns {Promise} the component's change_value promise (normal save + refresh)
*/
tool_transcription.prototype.save_transcription = function( html ) {

	const self		= this
	const component	= self.transcription_component

	return component.change_value({
		changed_data : [Object.freeze({
			action	: 'update',
			id		: 1,
			key		: 0,
			value	: {
				id		: 1,
				lang	: component.lang,
				value	: html
			}
		})],
		refresh : true
	})
}//end save_transcription



/**
* BUILD_PLACEHOLDER_TAG
* The UNRESOLVED speaker tag: the normal person-tag grammar with an EMPTY data
* payload — that emptiness is what marks it assignable later. The label P<n>
* renders on the tag badge, so the draft reads "P1 … P2 …" until identities
* are bound.
*
* @param {number} n - detected speaker number (1-based)
* @returns {string} e.g. '[person-a-1-P1-data::data]'
*/
export const build_placeholder_tag = function( n ) {

	return `[person-a-${n}-P${n}-data::data]`
}//end build_placeholder_tag


/**
* ASSIGN_SPEAKERS
* Bind identities to the speaker tags of the STORED transcription — any time,
* not only right after a run.
*
* THE FLOW THIS SERVES. A run with speaker detection saves IMMEDIATELY, with a
* placeholder tag (P1, P2, …) opening every detected turn. The archivist can
* correct the draft in the editor first — move a tag the detector misplaced,
* delete a false one, add a missed one — because until identities are bound
* the tags are just content. THEN this dialog binds them: it reads every
* distinct person tag out of the stored text (placeholders first, already
* resolved ones preselected), offers the record's own people, and applies the
* binding as a DETERMINISTIC TAG SWAP saved through the normal save path —
* the time machine keeps the pre-binding version, and re-binding a person to
* somebody else later is the same swap again.
*
* Identity is a human decision by design: no voice print ever says WHO a
* voice belongs to.
*
* @param {Object} [options]
* @param {number} [options.key=0] - which value of the component to bind
* @param {string} [options.value] - the text to scan, when the caller already
*   holds it (the just-saved run) — the component's stored entries otherwise.
*   Right after a save the instance refresh is still in flight, so the
*   auto-offer MUST pass the html it saved instead of racing the refresh.
* @param {Array<Object>} [options.persons] - the tags_persons feed, when the
*   caller captured it before a save (same refresh race as options.value).
* @returns {Promise<boolean|null>} true = a binding was saved; null = the
*   dialog opened but was cancelled/closed (tags untouched); false = nothing
*   to offer (no speaker tags in the text, or no persons declared)
*/
tool_transcription.prototype.assign_speakers = function( options ) {

	const self	= this
	const opts	= options || {}
	const key	= opts.key || 0

	const persons = Array.isArray(opts.persons) && opts.persons.length>0
		? opts.persons
		: ((self.transcription_component && self.transcription_component.data
			&& Array.isArray(self.transcription_component.data.tags_persons))
				? self.transcription_component.data.tags_persons
				: [])
	const entries	= ((self.transcription_component && self.transcription_component.data) || {}).entries || []
	const value		= (typeof opts.value==='string' && opts.value!=='')
		? opts.value
		: ((entries[key] || {}).value || '')

	// Every DISTINCT person tag in the stored text. The label field never
	// carries '-' (the tag field separator) and the data payload uses single
	// quotes, so this scan is exact.
	const TAG_RE	= /\[person-([a-z])-([0-9]{1,6})-([^-]{0,22}?)-data:(.*?):data\]/g
	const found		= new Map() // tag string -> descriptor
	let match
	while ((match = TAG_RE.exec( value ))!==null) {
		const tag = match[0]
		let entry = found.get( tag )
		if (!entry) {
			entry = { tag: tag, label: match[3], data: match[4], count: 0, indexes: [] }
			found.set( tag, entry )
		}
		entry.count++
		if (entry.indexes.length<2) {
			entry.indexes.push( match.index )
		}
	}
	if (found.size===0 || persons.length===0) {
		return Promise.resolve( false )
	}

	// Listen jump points: every tag sits right after a TC mark, so the nearest
	// preceding mark IS the turn's time.
	const tc_marks = [...value.matchAll(/\[TC_([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:\.[0-9]{1,3})?)_TC\]/g)]
		.map( m => ({ index: m.index, seconds: tc_to_seconds( m[1] ) }) )
	const seconds_at = function( idx ) {
		let best = null
		for (const mark of tc_marks) {
			if (mark.index<=idx) best = mark.seconds
			else break
		}
		return best
	}

	// Preselect resolved tags: their data locator matches a tags_persons entry.
	const person_index_of = function( data_string ) {
		if (!data_string) {
			return ''
		}
		try {
			const locator = JSON.parse( data_string.replace(/'/g, '"') )
			const idx = persons.findIndex( person => person.data
				&& person.data.section_tipo===locator.section_tipo
				&& String(person.data.section_id)===String(locator.section_id) )
			return idx===-1 ? '' : String(idx)
		} catch (error) {
			return ''
		}
	}

	// Placeholders (empty data) first — they are the ones waiting.
	const rows = [...found.values()].sort( (a, b) => (a.data==='' ? 0 : 1) - (b.data==='' ? 0 : 1) )

	return new Promise(function(resolve){

		let resolved = false
		const finish = function(result, modal) {
			if (resolved) return
			resolved = true
			if (modal) modal.close()
			resolve( result )
		}

		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content transcription_speakers_map'
		})

		const selects = [] // [{row, select, initial}]
		for (const row of rows) {

			const row_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'speaker_row',
				parent			: body
			})

			// The TAG ITSELF, rendered as its badge — the archivist is binding
			// exactly what they see in the text. Occurrence count as tooltip.
			const badge = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'speaker_label',
				parent			: row_node
			})
			badge.title = `${row.count} ×`
			badge.insertAdjacentHTML( 'afterbegin', self.transcription_component.tags_to_html( row.tag ) )

			for (const idx of row.indexes) {
				const seconds = seconds_at( idx )
				if (seconds===null) continue
				const jump = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'light speaker_listen',
					text_content	: `▶ ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`,
					parent			: row_node
				})
				jump.addEventListener('click', function(e){
					e.stopPropagation()
					if (self.media_component && typeof self.media_component.go_to_time==='function') {
						self.media_component.go_to_time({ seconds: seconds })
						if (self.media_component.video && typeof self.media_component.video.play==='function') {
							self.media_component.video.play()
						}
					}
				})
			}

			const person_select = ui.create_dom_element({
				element_type	: 'select',
				parent			: row_node
			})
			ui.create_dom_element({
				element_type	: 'option',
				value			: '',
				inner_html		: self.get_tool_label('no_person_tag') || '— unassigned —',
				parent			: person_select
			})
			for (let j = 0; j < persons.length; j++) {
				const person = persons[j]
				ui.create_dom_element({
					element_type	: 'option',
					value			: String(j),
					// (!) person name / role are RECORD values (the people section): TEXT,
					// never parsed as markup — stored XSS across users otherwise
					text_content	: `${person.full_name}${person.role ? ` (${person.role})` : ''}`,
					parent			: person_select
				})
			}
			const initial = person_index_of( row.data )
			person_select.value = initial
			selects.push({ row: row, select: person_select, initial: initial })
		}

		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content transcription_speakers_map_footer'
		})
		const button_apply = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_apply_speakers',
			inner_html		: self.get_tool_label('assign_speakers') || 'Assign speakers',
			parent			: footer
		})
		const button_cancel = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_skip_speakers',
			inner_html		: self.get_tool_label('cancel') || 'Cancel',
			parent			: footer
		})

		const modal = ui.attach_to_modal({
			header		: self.get_tool_label('speakers_detected') || 'Speakers',
			body		: body,
			footer		: footer,
			size		: 'small',
			on_close	: function() {
				finish( null, null ) // cancelled: nothing saved, tags stay as they are
			}
		})

		button_apply.addEventListener('click', function(e){
			e.stopPropagation()
			// The binding: swap every changed tag, ALL occurrences, one save.
			let new_value	= value
			let changed		= false
			for (const item of selects) {
				if (item.select.value==='' || item.select.value===item.initial) continue
				const person = persons[parseInt(item.select.value)]
				if (!person || typeof person.tag!=='string') continue
				new_value	= new_value.split( item.row.tag ).join( person.tag )
				changed		= true
			}
			if (changed) {
				self.save_transcription( new_value )
			}
			finish( changed, modal )
		})
		button_cancel.addEventListener('click', function(e){
			e.stopPropagation()
			finish( null, modal )
		})
	})
}//end assign_speakers



/**
* TRANSCRIPT_WORDS
* The SPOKEN TEXT of a stored transcription: timecode marks, markup and
* whitespace removed. Comparing it before and after a rebuild answers the only
* question a curator really has — did anything I wrote disappear?
*
* @param {string} value
* @returns {string}
*/
const transcript_words = function(value) {

	return String(value)
		.replace(/\[TC_[^\]]*_TC\]/g, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}//end transcript_words



/**
* TRANSCRIPT_TAGS
* Inventory of the INLINE markup of a stored transcription: element name → how
* many times it opens. `<p>` is excluded because rebuilding the paragraphs is the
* whole point of the operation; everything else is the archivist's apparatus
* (emphasis, foreign words, uncertain readings) and losing any of it is a loss.
*
* @param {string} value
* @returns {Object} { em:2, span:1, … }
*/
const transcript_tags = function(value) {

	const found		= String(value).match(/<[a-zA-Z][a-zA-Z0-9-]*[^>]*>/g) || []
	const inventory	= {}

	for (let i = 0; i < found.length; i++) {
		const name = found[i].replace(/^<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>$/, '$1').toLowerCase()
		if (name==='p') {
			continue
		}
		inventory[name] = (inventory[name] || 0) + 1
	}

	return inventory
}//end transcript_tags



/**
* LOST_TAGS
* The elements `before` has and `after` does not, as printable 'em (2)' strings.
*
* @param {string} before
* @param {string} after
* @returns {Array<string>}
*/
const lost_tags = function(before, after) {

	const from	= transcript_tags(before)
	const to	= transcript_tags(after)
	const lost	= []

	for (const name in from) {
		const missing = from[name] - (to[name] || 0)
		if (missing > 0) {
			lost.push( missing===1 ? name : `${name} (${missing})` )
		}
	}

	return lost
}//end lost_tags



/**
* REGROUP_PARAGRAPHS
* Re-paragraph the transcription that is ALREADY in the component.
*
* Transcripts made before the paragraph grouper existed (and any transcript whose
* owner wants a different timecode density) are a wall of five-second fragments,
* one per recogniser segment. This reads the stored text back into segments —
* the timecode marks are the only structure needed to do that — and rebuilds it
* with the current paragraph rules. Nothing is re-recognised.
*
* WHAT IT MAY AND MAY NOT CHANGE (corrected 2026-08-30 — the docblock here used to
* claim the operation "cannot change a single word", which was FALSE about markup
* and about entities, and is why nobody looked). The component is the RICH-TEXT
* one. Until that date the rebuild deleted every tag the value carried — emphasis,
* foreign-word marking, uncertain readings — and re-escaped every entity outside
* the four escape_html knows (`&#39;` was written back as the visible text
* `&amp;#39;`), silently, over a value a curator had already worked on
* (P0-12/CLI-24). `transcribers/lib/paragraphs.js` now carries each segment's
* stored fragment verbatim, so inline markup and entities survive and the
* operation is idempotent — but that is guaranteed for WELL-FORMED transcript
* markup, not for every shape a stored value can take:
*   - unbalanced markup is REPAIRED (closed at the paragraph end, re-opened in the
*     next; a close tag with no opening is dropped);
*   - a fragment with markup but no words (an image alone between two marks) is
*     still dropped, as it always was.
* So the rebuilt value is MEASURED against the current one, the operator is told
* what would be lost, and nothing is written without a confirmation.
*
* The value goes back through set_value, i.e. the normal component save: the
* previous text stays in the time machine like any other edit.
*
* @param {Object} [options]
* @param {Object} [options.format_options] - paragraph/timecode options (lib/paragraphs.js)
* @param {number} [options.key=0] - which value of the component to rebuild
* @returns {boolean} false ONLY when there is nothing to rebuild (the caller shows
*   the "no transcription" message on false). A rebuild the operator cancels, and
*   a rebuild that would change nothing, both return true and write nothing.
*/
tool_transcription.prototype.regroup_paragraphs = function(options) {

	const self		= this
	const opts		= options || {}
	const key		= opts.key || 0
	const entries	= (self.transcription_component.data || {}).entries || []
	const current	= (entries[key] || {}).value || ''

	if (current.trim()===''){
		return false
	}

	const segments = parse_transcript( current )
	if (segments.length===0) {
		return false
	}

	const new_value = segments_to_html( segments, opts.format_options || {} )

	// Already in this shape. Saving would only add a time-machine entry that
	// records nothing, so the operator is not asked and nothing is written.
	if (new_value===current) {
		return true
	}

	// The measured difference, not a promise: whatever the transform claims, what
	// the operator confirms is what this comparison actually found.
	const words_change	= transcript_words(new_value)!==transcript_words(current)
	const tags_lost		= lost_tags(current, new_value)

	let message = self.get_tool_label('regroup_paragraphs_confirm')
		|| 'Rebuild the paragraphs of this transcription?'

	if (words_change===true || tags_lost.length>0) {
		message += '\n\n' + (self.get_tool_label('regroup_paragraphs_changes') || 'This rebuild would not be exact:')
		if (words_change===true) {
			message += '\n· ' + (self.get_tool_label('regroup_paragraphs_text_changes') || 'the text itself would change')
		}
		if (tags_lost.length>0) {
			message += '\n· ' + (self.get_tool_label('regroup_paragraphs_format_lost') || 'formatting that would be lost') + ': ' + tags_lost.join(', ')
		}
	}

	message += '\n\n' + (self.get_tool_label('regroup_paragraphs_time_machine') || 'The current text is kept in the time machine.')

	if (!confirm( message )) {
		return true
	}

	self.transcription_component.set_value(
		key,
		new_value
	)

	return true
}//end regroup_paragraphs



/**
* ABORT_TRANSCRIPTION
* Cancel a running browser transcription, keeping what is already done.
*
* The worker cannot be interrupted mid-inference, so it is ASKED to stop: it
* finishes the window it is on and answers with an 'end' message carrying every
* segment recognised so far, which then travels the normal path into the text
* component. Terminating the worker outright would throw that away.
*
* @returns {boolean} true when there was something to cancel
*/
tool_transcription.prototype.abort_transcription = function() {

	const self = this

	if (!self.transcribe_worker) {
		return false
	}

	self.transcribe_worker.postMessage({ action: 'abort' })

	return true
}//end abort_transcription



/**
* AUTOMATIC_TRANSCRIPTION_SERVER
* Call the API to transcribe the audiovisual component with the source lang
* using a online service like babel or Google transcribe and save the resulting value
* (!) Tool transcription config transcriber must to be exists in register_tools section
*
* This is the server-side transcription path.  Unlike the browser path, this method
* only dispatches the job request and receives an immediate response containing a
* process ID (`pid`).  The caller is then responsible for polling via
* `check_server_transcriber_status` until the job completes.
*
* The PHP handler (`class.tool_transcription.php::automatic_transcription`) is resolved
* by `create_source(self, 'automatic_transcription')`.  That method must be listed in
* the tool's `API_ACTIONS` constant on the server.
*
* The request carries both the transcription and media DDO locators so the server can:
*   1. Read the media file path from the media component record.
*   2. Submit it to the remote transcription service.
*   3. Save the response text into the transcription component's section record.
*
* `self.context.config` is forwarded as-is so the PHP class can read installation-specific
* settings (API keys, endpoint URLs) stored in the tool's registered config component.
*
* Timeout: 3600 seconds.  The response is immediate (the server kicks off a background
* job and returns the pid), but network latency on slow connections can still be high.
*
* @param {Object} options - Server transcription options
* @param {string} options.transcriber_engine - Engine name identifier (e.g. 'babel')
* @param {string} options.transcriber_quality - Quality/model identifier (engine-specific)
* @param {string} options.source_lang - Dédalo language tag of the audio, e.g. 'lg-spa'
* @param {Object} options.nodes - DOM node references (same as automatic_transcription)
* @returns {Promise<Object>} API response shape:
*   {
*     result : { pid: string }  — on success; pid used for status polling
*     result : false            — on error
*     msg    : {string}         — human-readable status or error description
*   }
*/
tool_transcription.prototype.automatic_transcription_server = async function(options) {

	const self = this

	// options
		const transcriber_engine	= options.transcriber_engine
		const transcriber_quality	= options.transcriber_quality
		const nodes					= options.nodes

	// source lang
		const source_lang 			= options.source_lang

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source_server = create_source(self, 'automatic_transcription')

	// rqo
		const rqo_server = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source_server,
			options	: {
				source_lang : source_lang,
				transcription_ddo : {
					component_tipo	: self.transcription_component.tipo,
					section_id		: self.transcription_component.section_id,
					section_tipo	: self.transcription_component.section_tipo
				},
				media_ddo : {
					component_tipo		: self.media_component.tipo,
					section_id			: self.media_component.section_id,
					section_tipo		: self.media_component.section_tipo
				},
				transcriber_engine	: transcriber_engine,
				transcriber_quality	: transcriber_quality,
				config				: self.context.config
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo_server,
				retries : 1, // one try only
				timeout : 3600 * 1000 // 3600 secs waiting response
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> automatic_transcription API response:",'DEBUG',response);
				}

				resolve(response)
			})
		})

}//end automatic_transcription_server



/**
* CHECK_SERVER_TRANSCRIBER_STATUS
* Call the API to check the transcribe server status
* using a online service like babel or Google and check if server has done
* (!) Tool transcription config transcriber must to be exists in register_tools section
*
* Polls the server for the current state of a previously submitted server transcription
* job.  The `pid` value was returned by `automatic_transcription_server` and stored in
* the client-side IndexedDB under the key `'transcriber_process_<section_tipo>_<section_id>'`.
*
* The server responds with a numeric status code that maps to one of three states:
*   1 — No active process matching the pid (job vanished or was never started).
*   2 — Job is still running; the caller should poll again after a delay.
*   3 — Job completed; the transcription result has been written to the record.
*
* The `render_tool_transcription.get_server_status` helper wraps this method in a
* recursive setTimeout loop (4-second interval) that stops on status 1 or 3.
*
* `self.context.config` is forwarded so the PHP handler can locate the correct remote
* service connection settings (same as in `automatic_transcription_server`).
*
* @param {Object} options - Status check options
* @param {string} options.transcriber_engine - Engine name (must match the job's engine)
* @param {string|number} options.pid - Process ID returned by automatic_transcription_server
* @returns {Promise<Object>} API response shape:
*   {
*     result : { status: number }  — 1 (inactive) | 2 (running) | 3 (done)
*     msg    : {string}
*   }
*/
tool_transcription.prototype.check_server_transcriber_status = async function(options) {

	const self = this

	// options
		const transcriber_engine	= options.transcriber_engine
		const pid					= options.pid

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'check_server_transcriber_status')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				media_ddo : {
					component_tipo	: self.media_component.tipo,
					section_id		: self.media_component.section_id,
					section_tipo	: self.media_component.section_tipo
				},
				transcriber_engine	: transcriber_engine,
				config				: self.context.config,
				pid					: pid
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> check_server_transcriber_status API response:",'DEBUG',response);
				}

				resolve(response)
			})
		})
}//end check_server_transcriber_status



/**
* GET_CURRENT_LANG_INFO
* Resolve the current tool selected lang in this format:
* 	Label | tld3 | tld2
* 	Greek | lg-ell | el
*
* Looks up `lang` in `page_globals.dedalo_projects_default_langs` (an array of lang
* objects with `value`, `label`, and `tld2` properties) and formats a human-readable
* descriptor string.  Returns 'Unknown lang' when the code is not found in the project
* langs array, so the display always has a fallback.
*
* Exported and consumed by `render_tool_transcription.js` to update the lang info
* display in the transcriber configuration panel whenever the user switches the active
* transcription language.
*
* @param {string} lang - Dédalo language tag, e.g. 'lg-ell'
* @returns {string} Formatted string 'Label | tld3 | tld2' (e.g. 'Greek | lg-ell | el'),
*   or 'Unknown lang' if the lang code is not present in the project langs list.
*/
export const get_current_lang_info = function( lang ) {

	const found = (page_globals.dedalo_projects_default_langs || []).find(el => el.value === lang)
	if (!found) {
		return 'Unknown lang'
	}

	// (!) FILTERED, never a fixed three-part template. `tld2` is optional — a
	// project lang with no ISO 639-1 code (they exist: most minority and
	// historical langs have only a 3-letter code) rendered the literal word
	// "undefined" as the third part, in a line whose whole job is to state a
	// fact. An absent part is simply not a part.
	return [ found.label, found.value, found.tld2 ]
		.filter( part => typeof part==='string' && part!=='' )
		.join(' | ')
}//end get_current_lang_info



/**
* GET_LANG_LABEL
* The language's NAME, for a reader — 'Castellano', not 'Castellano | lg-spa | es'.
*
* The codes belong to whoever is debugging a mapping, and the readiness panel is
* not written for them: a line saying the same word three times, twice in machine
* spelling, is noise in the one place the tool states what it is about to do. They
* are kept, on the row's `title`, so nothing is lost — see refresh_readiness.
*
* @param {string} lang - Dédalo language tag, e.g. 'lg-ell'
* @returns {string} the lang's label, or the tag itself when the project does not
*   declare it (never 'undefined', never an empty string).
*/
export const get_lang_label = function( lang ) {

	const found = (page_globals.dedalo_projects_default_langs || []).find(el => el.value === lang)


	return (found && typeof found.label==='string' && found.label!=='')
		? found.label
		: (lang || 'Unknown lang')
}//end get_lang_label



// @license-end
