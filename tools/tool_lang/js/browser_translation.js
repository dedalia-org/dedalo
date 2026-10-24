// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* SHARED BROWSER TRANSLATION ENGINE
* Client-side AI translation orchestration shared by tool_lang and tool_lang_multi.
*
* Runs the TranslateGemma 4B model entirely in the browser through the
* Web Worker at tools/tool_lang/translators/browser_transformer/browser_transformer.js
* (HuggingFace Transformers + ONNX runtime).
*
* Design:
* - A single module-level worker is reused across calls so the (heavy) model
*   is downloaded/compiled once and cached inside the worker. This is critical
*   for the tool_lang_multi "translate to all languages" loop where many target
*   langs are translated sequentially.
* - The worker is NOT terminated on a normal 'end'; use dispose_browser_worker()
*   to free resources (on tool destroy, fatal error or cancel).
*
* Translation pipeline for each call to translate_component_browser():
*   1. Extract source HTML from component data (entries[] or value[]).
*   2. Replace Dédalo inline tags (indexIn, tc, svg, …) with [[n]] placeholders
*      so the LLM never sees or corrupts them.
*   3. Convert the resulting HTML to Markdown via html_to_markdown().
*   4. Split into ≤1000-char chunks via group_markdown_into_chunks().
*   5. Post chunks + lang codes to the shared worker.
*   6. Stream 'on_chunk' partial results into the target component's DOM.
*   7. On 'end' AND ONLY when every block translated: restore placeholders,
*      rebuild v7 entry objects, save() + refresh().
*   8. When any block failed (the worker posts 'on_block_error' and SKIPS the
*      block, so its accumulated text is short), or the run produced no text at
*      all, the run is REFUSED: nothing is saved, the target component's pre-run
*      data is put back, the lost blocks are named in the status area and the
*      returned Promise REJECTS. Saving what survived would overwrite the target
*      language's existing — possibly human-made — text with a silently
*      shortened machine translation, and report it as a success.
*
* Exports:
*   get_browser_worker          — lazy-initialise the shared Worker
*   dispose_browser_worker      — terminate and null the shared Worker
*   cancel_browser_translation  — post a cancel signal to the worker
*   translate_component_browser — the main orchestrator (async)
*/

// imports
	import {clone, get_json_langs} from '../../../core/common/js/utils/index.js'
	import {tr} from '../../../core/common/js/tr.js'
	import {html_to_markdown, markdown_to_html, group_markdown_into_chunks} from './markdown_utils.js'



/**
* ERROR_NODE
* Builds the `.error` status node with the message as a TEXT node. The message
* is engine/worker text (exception message, file path, stack fragment) and must
* NEVER be parsed as HTML (DS-1, error_report_xss_tripwire).
* @param {string} message
* @return HTMLElement
*/
const error_node = function(message) {

	const node = document.createElement('div')
	node.className	= 'error'
	node.textContent = String(message)

	return node
}//end error_node



/**
* STATUS_LINES_NODE
* Builds a multi-line status node: one child div per line, each line set as a
* TEXT node. Lines carry worker text (per-block exception messages, timeout
* text) and must NEVER be parsed as HTML (DS-1, error_report_xss_tripwire).
* @param {string} class_name - 'error' for a refused run, 'warning' while running.
* @param {Array<string>} lines
* @return HTMLElement
*/
const status_lines_node = function(class_name, lines) {

	const node = document.createElement('div')
	node.className = class_name

	for (let i = 0; i < lines.length; i++) {
		const line = document.createElement('div')
		line.textContent = String(lines[i])
		node.appendChild(line)
	}

	return node
}//end status_lines_node



/**
* Module-level reusable worker. Lazy created.
* @type {Worker|null}
*/
let shared_worker = null



/**
* GET_BROWSER_WORKER
* Lazily create (or reuse) the shared translation worker.
*
* The Worker is instantiated with `type: 'module'` so browser_transformer.js
* can use ES-module imports. The path is relative to the HTML page, not this
* module file, so it must remain the canonical tool_lang path regardless of
* which tool (tool_lang or tool_lang_multi) calls this function.
*
* The singleton pattern is intentional: re-using the same Worker across
* repeated calls avoids re-downloading and re-compiling the ~1.5 GB ONNX
* model. Callers that need a fresh worker (e.g. after a fatal error) must
* call dispose_browser_worker() first.
* @returns {Worker} The shared worker instance (newly created or cached).
*/
export const get_browser_worker = function() {

	if (!shared_worker) {
		shared_worker = new Worker(
			'../../tools/tool_lang/translators/browser_transformer/browser_transformer.js',
			{ type : 'module' }
		)
	}

	return shared_worker
}//end get_browser_worker



/**
* DISPOSE_BROWSER_WORKER
* Terminate and null the shared worker, freeing the ONNX model from memory.
*
* Should be called:
*   - when the parent tool is destroyed (component lifecycle `destroy()`)
*   - after a fatal 'error' status from the worker (translate_component_browser
*     calls this automatically in that branch)
*   - when the user explicitly closes the translation panel
*
* Safe to call when no worker exists (no-op). Any subsequent call to
* get_browser_worker() will recreate the worker and reload the model.
* @returns {boolean} Always true.
*/
export const dispose_browser_worker = function() {

	if (shared_worker) {
		try {
			shared_worker.terminate()
		} catch (error) {
			console.error('Error terminating browser translation worker:', error)
		}
		shared_worker = null
	}

	return true
}//end dispose_browser_worker



/**
* CANCEL_BROWSER_TRANSLATION
* Ask the worker to abort the in-progress translation between blocks.
*
* Sends `{ cancel: true }` to the worker via postMessage. The worker checks
* this flag between block translations and responds with a 'cancelled' status
* message before stopping. The Promise returned by translate_component_browser
* resolves (not rejects) with `{ result: false, msg: 'Translation cancelled' }`
* when the worker acknowledges the cancellation.
*
* Note: cancellation is cooperative and takes effect only at a block boundary.
* A block already being processed by the model will run to completion first.
* The worker is NOT terminated — call dispose_browser_worker() afterwards if
* the user wants to fully release the model from memory.
*
* Nothing partial survives a cancellation: the blocks translated so far were
* streamed into the target component's live data by 'on_chunk', and the
* 'cancelled' handler puts the component's own value back before resolving.
* @returns {boolean} Always true (the signal is fire-and-forget).
*/
export const cancel_browser_translation = function() {

	if (shared_worker) {
		shared_worker.postMessage({ cancel : true })
	}

	return true
}//end cancel_browser_translation



/**
* DEDALO_TO_LOCALE
* Convert a Dédalo lang code (e.g. 'lg-eng') to a BCP 47 base-language locale
* code (e.g. 'en') expected by the TranslateGemma model prompt.
*
* The conversion uses the `locale` field of the matching entry in `json_langs`
* (the platform's language registry). Only the primary-language subtag is kept
* (everything before the first '-' in a full locale like 'en-US') because
* TranslateGemma's prompt expects short codes ('en', 'es', 'fr', …).
*
* Falls back to 'en' when the Dédalo code is unknown or the entry has no
* `locale` field. This is a safe default (the model always understands English)
* but callers should ensure json_langs is fully populated to avoid silent
* fall-backs for languages other than English.
* @param {string} dedalo_lang - Dédalo internal lang identifier, e.g. 'lg-eng'.
* @param {Array}  json_langs  - Array of lang-registry objects, each with at
*                               minimum { dd_lang: string, locale: string }.
*                               Obtained via get_json_langs() or options.json_langs.
* @returns {string} Short locale code ('en', 'es', 'fr', …), default 'en'.
*/
const dedalo_to_locale = function(dedalo_lang, json_langs) {

	const lang_obj = json_langs.find(item => item.dd_lang===dedalo_lang)
	if (!lang_obj || !lang_obj.locale) {
		return 'en'
	}

	return lang_obj.locale.split('-')[0]
}//end dedalo_to_locale



/**
* REPLACE_DEDALO_TAGS_WITH_PLACEHOLDERS
* Substitute Dédalo inline-markup tags with numbered [[n]] tokens so the LLM
* never sees (and thus cannot corrupt) them.
*
* Dédalo transcriptions embed structured annotations directly in the HTML text
* using a custom tag syntax handled by the TR class (e.g. index markers, time-
* codes, SVG anchors). These must survive translation verbatim. Passing them to
* the model as-is risks garbling, partial translation, or removal of the tag.
*
* How it works:
*   For each tag name in the hardcoded list, tr.get_mark_pattern(tag) returns
*   a compiled global RegExp. Every match in the source text is replaced with a
*   unique '[[n]]' placeholder (counter starts at 1, increments per match across
*   all tag types). The original matched string is stored in the `placeholders`
*   map keyed by its placeholder token.
*
*   restore_placeholders() reverses this transformation after translation.
*
* Tag names handled (order matters — patterns must not overlap):
*   indexIn, indexOut, tc, svg, geo, page, person, note, reference, lang
*
* @param {string} source_text - Full HTML string, possibly containing Dédalo markup tags.
* @returns {{ safe_source_text: string, placeholders: Object }}
*   safe_source_text — input with all Dédalo tags replaced by [[n]] tokens.
*   placeholders     — map of { '[[n]]': original_tag_string } for restoration.
*/
const replace_dedalo_tags_with_placeholders = function(source_text) {

	const tags = [
		'indexIn',
		'indexOut',
		'tc',
		'svg',
		'geo',
		'page',
		'person',
		'note',
		'reference',
		'lang'
	]

	let safe_source_text = source_text
	const placeholders = {}
	let counter = 1
	for (let i = 0; i < tags.length; i++) {
		const tag = tags[i]
		const pattern = tr.get_mark_pattern(tag)

		safe_source_text = safe_source_text.replace(pattern, (match) => {
			const key = `[[${counter}]]`
			placeholders[key] = match
			counter++
			return key
		})
	}

	return { safe_source_text, placeholders }
}//end replace_dedalo_tags_with_placeholders



/**
* RESTORE_PLACEHOLDERS
* Reverse the substitution performed by replace_dedalo_tags_with_placeholders,
* reinserting original Dédalo tag strings at their placeholder positions.
*
* Uses `replaceAll` with a function form to avoid treating the original tag
* strings as replacement patterns (which would misinterpret '$' characters
* that appear inside Dédalo tag data payloads).
*
* The function form `() => original` ensures the replacement value is treated
* as a literal string rather than a replacement-pattern string. This is
* important because Dédalo tags can contain data payloads with special chars.
* @param {string} translated_text - Text returned by the LLM, still containing [[n]] tokens.
* @param {Object} placeholders    - Map produced by replace_dedalo_tags_with_placeholders.
* @returns {string} Translated text with all [[n]] tokens replaced by their original tags.
*/
const restore_placeholders = function(translated_text, placeholders) {

	return Object.entries(placeholders).reduce(
		(text, [key, original]) => text.replaceAll(key, () => original),
		translated_text
	)
}//end restore_placeholders



/**
* GET_SOURCE_TEXT
* Extract the first source HTML string and its entry object from a component instance.
*
* Dédalo component data can be shaped in two ways depending on the component type
* and the server response version:
*   - v7 style: `data.entries[]` — array of { id, value } objects (preferred)
*   - legacy:   `data.value[]`   — plain array of strings
*
* This function normalises both shapes: it looks for `entries` first, then falls
* back to `value`. A scalar (non-array) value is also accepted and wrapped in
* an array, which handles components that return a bare string.
*
* `first_entry` is returned alongside `source_text` so that the caller can
* extract the `id` field for constructing the target entry object (id must be
* preserved across the source→target language pair to maintain the shared-id
* contract used by the v7 data model).
* @param {Object} source_component - A fully initialised component instance with a
*                                    `data` property (entries[] or value[]).
* @returns {{ source_text: string, first_entry: Object|string|null }}
*   source_text  — First entry value as a string, or '' if data is empty.
*   first_entry  — The raw first array element (may be an object or a string),
*                  or null if the data array was empty.
*/
const get_source_text = function(source_component) {

	const raw_value = source_component.data.entries || source_component.data.value
	const source_entries = Array.isArray(raw_value)
		? raw_value
		: (raw_value ? [raw_value] : [])

	if (source_entries.length<1) {
		return { source_text : '', first_entry : null }
	}

	const first_entry = source_entries[0]
	const source_text = (typeof first_entry==='string')
		? first_entry
		: (first_entry?.value || '')

	return { source_text, first_entry }
}//end get_source_text



/**
* TRANSLATE_COMPONENT_BROWSER
* Translate one source component into one target component fully client-side,
* streaming partial results into the target component's DOM and persisting the
* final result via component.save() + component.refresh().
*
* This is the primary export consumed by both tool_lang (single-pair) and
* tool_lang_multi (translate-all-languages loop). It wraps the entire
* async pipeline in a single Promise so callers can await or chain it.
*
* Worker communication (see browser_transformer.js for the full protocol):
*   Main → Worker: { options: { blocks[], sourceLangCode, targetLangCode, device } }
*   Worker → Main: sequence of status messages handled by the switch inside the
*                  Promise: 'init' | 'on_chunk' | 'end' | 'on_block_error' |
*                  'cancelled' | 'error'
*
* Data-model update on 'end' — ONLY for a COMPLETE run:
*   Both `target_component.data.value[]` (legacy) and `target_component.data.entries[]`
*   (v7) are updated before save() so the component reflects the translation
*   regardless of which data shape the server expects. The entry `id` is
*   preserved from the existing target entry when it exists, otherwise it falls
*   back to the source entry id, maintaining the shared cross-language id contract.
*
* Refusal on an INCOMPLETE run:
*   The worker does not abort on a block failure — it posts 'on_block_error' and
*   SKIPS that block, so its accumulated text is short by exactly the paragraphs
*   that failed. Every such message is counted here, and 'end' with a non-zero
*   count (or with an empty result) saves NOTHING: the streamed partial text is
*   removed from target_component.data, the component is re-rendered from its own
*   untouched data and the Promise REJECTS naming the lost blocks. A partial
*   translation is never written and never marked with a placeholder — writing
*   either into a heritage record destroys the curator's existing text.
*
* @param {Object} options
* @param {Object}        options.source_component           - Initialised component
*                                                             supplying the source text.
* @param {Object}        options.target_component           - Initialised component that
*                                                             will receive and save the
*                                                             translated text.
* @param {string}        options.source_lang                - Dédalo lang code, e.g. 'lg-eng'.
* @param {string}        options.target_lang                - Dédalo lang code, e.g. 'lg-spa'.
* @param {string}        [options.device='webgpu']          - ONNX execution provider:
*                                                             'webgpu' (GPU-accelerated) or
*                                                             'wasm' (CPU fallback).
* @param {HTMLElement}   options.status_container           - Element for status/progress text.
* @param {HTMLElement|null} [options.streaming_overlay]     - Overlay element shown while
*                                                             translation is streaming.
* @param {HTMLElement|null} [options.streaming_overlay_content] - Inner element of the
*                                                             overlay; receives incremental HTML.
* @param {Array|null}    [options.json_langs]               - Pre-fetched lang-registry array.
*                                                             Fetched via get_json_langs() when
*                                                             absent (avoids duplicate network
*                                                             requests in multi-lang loops).
* @param {Function}      [options.get_label]                - Tool label resolver: (key) => string.
*                                                             Defaults to identity (key => key).
* @returns {Promise<{result: boolean, msg: string}>}
*   Resolves on a COMPLETE translation (saved) or on user cancellation (nothing
*   saved); rejects on fatal worker errors, empty source text, and on an
*   incomplete run — see "Refusal" above. Rejection (not a resolve carrying
*   result:false) is load-bearing: tool_lang's click handler paints its own
*   'Translation completed' banner in .then(), and tool_lang_multi's
*   automatic_translation_all counts every resolved promise as ok in its
*   (n/total) summary — so a resolve here would report success for a run that
*   saved nothing.
*/
export const translate_component_browser = async function(options) {

	// options
		const source_component			= options.source_component
		const target_component			= options.target_component
		const source_lang				= options.source_lang
		const target_lang				= options.target_lang
		const device					= options.device || 'webgpu'
		const status_container			= options.status_container
		const streaming_overlay			= options.streaming_overlay || null
		const streaming_overlay_content	= options.streaming_overlay_content || null
		const get_label					= typeof options.get_label==='function'
			? options.get_label
			: (key) => key // identity fallback: show raw key when no label map is provided

	// source text
		const { source_text, first_entry } = get_source_text(source_component)
		if (!source_text) {
			return Promise.reject('Empty source text')
		}

	// language mapping
		const json_langs = options.json_langs || await get_json_langs() || []

		const source_lang_code = dedalo_to_locale(source_lang, json_langs)
		const target_lang_code = dedalo_to_locale(target_lang, json_langs)

	// clean hard coded spaces
	// &nbsp; entities confuse the markdown converter and appear verbatim in the
	// model input; replace them with regular spaces before further processing.
		const clean_source_text = source_text.replace(/&nbsp;/g, ' ')

	// create placeholders to avoid translating Dédalo tags
		const { safe_source_text, placeholders } = replace_dedalo_tags_with_placeholders(clean_source_text)

	// convert HTML to markdown for the LLM
		const md_source_text = html_to_markdown(safe_source_text)

	// parse markdown into chunks
	// The worker translates one chunk at a time; the 1000-char limit keeps each
	// block well within the model's MAX_NEW_TOKENS=2048 budget.
		const blocks = group_markdown_into_chunks(md_source_text, 1000)

	// reusable worker (model cached across calls)
		const translate_worker = get_browser_worker()

	// wrap in a Promise to allow the caller to await completion
	return new Promise(function(resolve, reject){

		if (status_container) {
			status_container.classList.remove('hide')
			status_container.classList.add('loading_status')
		}

		// show streaming overlay over the target component
		if (streaming_overlay) {
			streaming_overlay.classList.remove('hide')
			if (streaming_overlay_content) {
				streaming_overlay_content.innerHTML = ''
			}
		}

		// failed_blocks. Every 'on_block_error' the worker posts for THIS run.
		// The worker does NOT stop on a block failure: it skips the block and keeps
		// translating (browser_transformer.js, the catch inside the block loop —
		// "Skip this block — accumulated_text stays unchanged"), so its final
		// accumulated text is short by exactly those paragraphs and nothing in the
		// payload says so. This list is the only record that text is missing, and
		// the 'end' case below refuses to save while it is non-empty.
		// Per-run state: onmessage is reassigned on every call to this function, so
		// this closure is never shared between two translations of the shared worker.
			const failed_blocks = []

		// target_data_snapshot. The target component's data as it was BEFORE any
		// partial result was streamed into it: 'on_chunk' writes the in-progress
		// translation straight into target_component.data.value[0], so a refused run
		// must put this back or the truncated text stays on screen looking saved.
		// has_value / has_entries keep the "key was absent" case distinct from
		// "key was present and empty" — a component that had no value must keep
		// having none.
			const target_data_snapshot = {
				has_value	: Object.hasOwn(target_component.data, 'value'),
				value		: clone(target_component.data.value ?? null),
				has_entries	: Object.hasOwn(target_component.data, 'entries'),
				entries		: clone(target_component.data.entries ?? null)
			}

		/**
		* RESTORE_TARGET_DATA
		* Undo the streaming preview: put target_component.data back to the snapshot
		* and re-render the component from it.
		*
		* Every run that does not save MUST call this. 'on_chunk' writes the partial
		* translation into the live instance data, so leaving it there hands the next
		* change_value/save of that component a machine-made fragment to persist —
		* the same silent overwrite, only deferred.
		* @return void
		*/
		const restore_target_data = function() {

			// restore the pre-run data (delete the key when there was none)
				if (target_data_snapshot.has_value) {
					target_component.data.value = clone(target_data_snapshot.value)
				}else{
					delete target_component.data.value
				}
				if (target_data_snapshot.has_entries) {
					target_component.data.entries = clone(target_data_snapshot.entries)
				}else{
					delete target_component.data.entries
				}

			// re-render from the restored data. build_autoload:false rebuilds the
			// instance from its own data (common.refresh step 4) instead of
			// re-fetching — and that data IS the stored value, because these paths
			// never called save(). common.refresh returns false without rebuilding when
			// the instance status is not 'rendered'; the restored data is what any later
			// render reads either way, and the caller's outcome does not depend on it.
				Promise.resolve()
				.then(function(){
					return target_component.refresh({
						build_autoload : false
					})
				})
				.catch(function(refresh_error){
					// a failed re-render does not change the outcome: nothing was written
					console.error('Refresh failed after a translation that saved nothing:', refresh_error)
				})
		}//end restore_target_data



		/**
		* REFUSE_RUN
		* Abandon the translation WITHOUT WRITING ANYTHING: put the target
		* component's own data back, re-render it from that data, name what went
		* wrong in the status area and reject.
		*
		* Rejecting (instead of resolving with result:false) is load-bearing on both
		* callers: tool_lang's click handler paints its own 'Translation completed'
		* banner over this status area in .then() (render_tool_lang.js
		* build_automatic_translation), and tool_lang_multi's
		* automatic_translation_all counts every resolved promise as ok in its
		* (n/total) summary. A resolve here would erase this message and report
		* success for a run that saved nothing.
		* @param {Array<string>} lines - operator-facing message, one line each.
		* @return void
		*/
		const refuse_run = function(lines) {

			if (streaming_overlay) {
				streaming_overlay.classList.add('hide')
			}

			restore_target_data()

			if (status_container) {
				status_container.classList.remove('loading_status')
				status_container.replaceChildren(status_lines_node('error', lines))
			}

			reject(new Error(lines.join(' ')))
		}//end refuse_run

		// handle messages sent back from the worker
		translate_worker.onmessage = function(e) {

			const status			= e.data.status
			const data				= e.data.data
			const remaining			= data.remaining
			const accumulated_text	= data.accumulated_text

			switch (status) {

				// model is being downloaded and initialised; show progress percentage
				case 'init': {

					const progress		= data.progress
					const status_text	= data.status
					const device_text	= data.device

					// 'setting_up' label shown after model is loaded (GPU path);
					// 'procesing' (sic) is reused on the WASM path during model compile.
				const process_label = device_text==='webgpu' ? 'setting_up' : 'procesing'

					// 'ready'          — model is compiled, about to start translating
					// 'fallback_to_wasm' — WebGPU unavailable; worker fell back to WASM CPU
					// (other)          — model is still downloading/compiling
					const label = status_text==='ready'
						? get_label( process_label )
						: (status_text==='fallback_to_wasm')
							? (get_label('gpu_unavailable') || 'GPU unavailable, switching to CPU')
							: get_label( 'initializing' )

					// progress is a 0–100 number during download; absent once loading is done.
					// padStart(2, 0) zero-pads single-digit percentages ('09%' not '9%').
					const loaded = (progress)
						? ` : ${parseInt(progress).toString().padStart(2, 0)}%`
						: (status_text==='ready')
							? ''
							: ' : 00%'
					if (status_container) {
						status_container.textContent = `${label}${loaded}`
					}
					break;
				}

				// translation chunk received; stream into the target component
				case 'on_chunk': {

					if (status_container) {
						status_container.classList.remove('loading_status')
						const procesing_label = get_label('procesing') || 'Procesing'
						const remaining_label = get_label('remaining') || 'remaining'
						status_container.innerText = `${procesing_label} (${remaining} ${remaining_label})`
					}

					// Convert the accumulated markdown to HTML and push into the
					// component's live data so the component's own render reflects
					// the in-progress translation without a server round-trip.
					const html_accumulated = markdown_to_html(accumulated_text)
					if (!target_component.data.value) {
						target_component.data.value = []
					}
					target_component.data.value[0] = html_accumulated
					if (streaming_overlay_content) {
						// Mirror the partial result into the streaming overlay so the
						// user sees live output even before the component re-renders.
						streaming_overlay_content.innerHTML = html_accumulated
					}
					break;
				}

				// the worker has stopped. It posts 'end' whether or not every block
				// translated, so this case decides between SAVING a complete translation
				// and REFUSING an incomplete one. Nothing above the two refusals may
				// report success or touch the stored value.
				case 'end': {

					// REFUSAL 1 — blocks were lost.
					// The accumulated text is missing those paragraphs. Saving it would
					// overwrite the target language's existing text — which may be a
					// human translation — with a shorter machine one, and the operator
					// would be told it completed. Name the lost blocks (capped at MAX_LISTED,
					// so a run that lost dozens still shows the "nothing was saved" line
					// without scrolling) and state that the existing text is intact: that
					// is the fact a curator needs first.
					if (failed_blocks.length > 0) {

						const MAX_LISTED	= 10
						const total_blocks	= failed_blocks[0].total
						const block_label	= get_label('block_error') || 'Block error'

						const lines = [
							`${get_label('translation_incomplete') || 'Translation refused: the model failed on part of the text'} (${failed_blocks.length}/${total_blocks})`
						]
						const listed = Math.min(failed_blocks.length, MAX_LISTED)
						for (let i = 0; i < listed; i++) {
							const failed = failed_blocks[i]
							lines.push(`${block_label} ${failed.block}/${failed.total}: ${failed.message}`)
						}
						if (failed_blocks.length > MAX_LISTED) {
							lines.push(`… +${failed_blocks.length - MAX_LISTED}`)
						}
						lines.push(get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.')
						lines.push(get_label('translation_retry') || 'Run the translation again to retry.')

						refuse_run(lines)
						break;
					}

					// Prefer accumulated_text (streaming model); fall back to stringifying
					// the raw data payload for non-streaming worker implementations.
					const translated_md = accumulated_text ?? String(data)

					// markdown -> HTML, then restore Dédalo tag placeholders
					const translated_html = markdown_to_html(translated_md)
					const restored_text = restore_placeholders(translated_html, placeholders)

					// REFUSAL 2 — the run produced no text at all.
					// The source was checked non-empty before the worker was started (the
					// 'Empty source text' rejection above), so an empty result is a failure
					// however the worker reached it (zero blocks, a non-streaming payload
					// that stringified to nothing). Saving it would BLANK the target
					// language and answer ok.
					if (!restored_text || restored_text.trim()==='') {
						refuse_run([
							get_label('translation_empty_result') || 'Translation refused: the model returned no text',
							get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.',
							get_label('translation_retry') || 'Run the translation again to retry.'
						])
						break;
					}

					// complete run: every block translated and the result is not empty
					if (streaming_overlay) {
						streaming_overlay.classList.add('hide')
					}
					if (status_container) {
						status_container.classList.remove('loading_status')
						status_container.innerHTML = get_label('translation_completed') || 'Translation completed'
					}

					// shared cross-language id from source entry
					// v7 entries carry an `id` that is shared across language variants of
					// the same logical value (e.g. the same paragraph in English and Spanish
					// share the same id). Extract it from the source entry object when present.
					const source_id = (typeof first_entry==='object' && first_entry!==null)
						? (first_entry.id ?? null)
						: null

					// use target's own id if it exists, else fall back to source id
					// Priority: (1) existing target entry id, (2) source entry id, (3) no id.
					// Preserving the target's own id is critical when a previous translation
					// already created a server-side record — overwriting with the source id
					// would create a duplicate entry.
					const target_entries = target_component.data.entries || []
					const existing_target_id = target_entries.length > 0 && target_entries[0]?.id !== undefined
						? target_entries[0].id
						: null
					const entry_id = existing_target_id ?? source_id

					// build v7 entry object
					// (!) entry_id may be null for brand-new components with no prior data;
					// in that case the server assigns an id on save and returns it in the response.
					const entry = (entry_id !== null)
						? { id: entry_id, value: restored_text }
						: { value: restored_text }

					// update legacy value array
						if (!target_component.data.value) {
							target_component.data.value = []
						}
						target_component.data.value[0] = restored_text

					// update entries array (v7 data model)
						if (!target_component.data.entries) {
							target_component.data.entries = []
						}
						if (target_component.data.entries.length === 0) {
							target_component.data.entries.push(entry)
						} else {
							target_component.data.entries[0] = entry
						}

					// save and resolve after save completes
					// The save_item shape follows the standard component save protocol:
					// action:'update' with id (may be null for new entries) and a v7 entry value.
					const save_item = {
						action	: 'update',
						id		: entry_id,
						value	: entry
					}
					target_component.save([save_item])
					.then(function(){
						return target_component.refresh({
							build_autoload : false
						})
					})
					.then(function(){
						resolve({result: true, msg: 'OK. Translation completed'})
					})
					.catch(function(save_error){
						console.error('Save failed after translation:', save_error)
						reject(save_error)
					})
					break;
				}

				// per-block failure. Non-fatal FOR THE WORKER (it skips the block and
				// translates the rest) but fatal for the RESULT: the text of this block
				// is gone from the accumulated translation. Record it — 'end' refuses to
				// save while failed_blocks is non-empty — and keep the run going so the
				// operator sees the whole account at once instead of one block at a time.
				case 'on_block_error': {
					failed_blocks.push({
						block	: data.block,
						total	: data.total,
						message	: data.message
					})
					console.warn(`Block ${data.block}/${data.total} failed: ${data.message}`)
					if (status_container) {
						const block_warn_label = get_label('block_error') || 'Block error'
						// the RUNNING COUNT, not only the last failure: a run can lose
						// several blocks and the earlier ones must not disappear from view
						status_container.replaceChildren(status_lines_node('warning', [
							`${block_warn_label}: ${data.block}/${data.total} (${failed_blocks.length})`
						]))
					}
					if (data.accumulated_text && streaming_overlay_content) {
						streaming_overlay_content.innerHTML = markdown_to_html(data.accumulated_text)
					}
					break;
				}

				// translation cancelled by user. The worker stopped between blocks, so
				// the accumulated text is a fragment; it was never saved, but 'on_chunk'
				// left it in the live instance data — put the target's own value back
				// before the component can carry the fragment into a later save.
				case 'cancelled': {
					if (streaming_overlay) {
						streaming_overlay.classList.add('hide')
					}
					restore_target_data()
					if (status_container) {
						status_container.classList.remove('loading_status')
						status_container.innerHTML = get_label('translation_cancelled') || 'Translation cancelled'
					}
					resolve({result: false, msg: 'Translation cancelled'})
					break;
				}

				// fatal worker error; dispose worker and reject. Whatever had already
				// been streamed into the target component is a fragment of a run that
				// died — put the target's own value back so it cannot be carried into
				// a later save of that component.
				case 'error': {
					dispose_browser_worker()
					if (streaming_overlay) {
						streaming_overlay.classList.add('hide')
					}
					restore_target_data()
					if (status_container) {
						status_container.classList.remove('loading_status')
					}
					const error_msg = data.message || data.name || String(data)
					console.error('Worker error details:', data)
					if (status_container) {
						// worker/engine text (exception message, file path): TEXT only (DS-1)
						status_container.replaceChildren(error_node(error_msg))
					}
					reject(new Error(error_msg))
					break;
				}
			}
		}

		// handle uncaught runtime errors from the worker
		// onerror fires for script-level failures (parse errors, missing imports)
		// that the worker itself cannot catch. These are always fatal — dispose
		// the broken worker so a fresh one is created on the next call.
		translate_worker.onerror = function(e) {
			const msg = e.message || e.filename || 'Unknown worker error'
			console.error('Worker error [browser_transformer]:', msg, e)
			dispose_browser_worker()
			if (streaming_overlay) {
				streaming_overlay.classList.add('hide')
			}
			// same as the fatal 'error' case: nothing was saved, so nothing partial
			// may be left in the component's live data
			restore_target_data()
			if (status_container) {
				status_container.classList.remove('loading_status')
				// worker/engine text (exception message, file path): TEXT only (DS-1)
				status_container.replaceChildren(error_node(msg))
			}
			reject(e)
		}

		// init the worker for translation
		// camelCase property names (sourceLangCode / targetLangCode) are required by
		// the browser_transformer worker's message-handling contract.
		translate_worker.postMessage({
			options : {
				blocks			: blocks,
				sourceLangCode	: source_lang_code,
				targetLangCode	: target_lang_code,
				device			: device
			}
		})
	})
}//end translate_component_browser



// @license-end
