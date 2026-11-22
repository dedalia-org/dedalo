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
*   2. Replace Dédalo inline marks (index, tc, svg, …) with [[[n]]] placeholders
*      (placeholders.js) in document order, so the LLM never sees or corrupts them,
*      and classify each as the open/close half of a pair or a standalone atom.
*   3. Convert the resulting HTML to Markdown via html_to_markdown().
*   4. Split into ≤1000-char chunks via group_markdown_into_chunks() and renumber
*      each chunk's placeholders locally (build_blocks).
*   5. Post the blocks + lang codes to the shared worker. The worker (block_runner.js)
*      normalises the tokens the model mangled, asks the model again for the ones it
*      dropped, and re-inserts the rest itself (repair_placeholders), naming every
*      token IT placed in repair_stats.
*   6. Stream 'on_chunk' partial results (marks restored) into the target component's DOM.
*   7. On 'end' AND ONLY when every block translated: restore the marks (duplicated /
*      invented tokens dropped), put inverted open/close pairs back in order
*      (reorder_inverted_pairs), account for every mark against the source
*      (validate_translation), rebuild v7 entry objects, save() + refresh(). Marks WE
*      placed are saved and reported ('translation_saved_with_warnings'), never as a
*      clean completion.
*   8. When any block failed (the worker posts 'on_block_error' and SKIPS the
*      block, so its accumulated text is short), the run produced no text at all, or
*      a mark is missing, invented or could not be placed, the run is REFUSED:
*      nothing is saved, the target component's pre-run data is put back, the
*      reason is named in the status area and the returned Promise REJECTS. Saving
*      what survived would overwrite the target language's existing — possibly
*      human-made — text with a silently damaged machine translation, and report it
*      as a success.
*
* Exports:
*   get_browser_worker          — lazy-initialise the shared Worker
*   dispose_browser_worker      — terminate and null the shared Worker
*   cancel_browser_translation  — post a cancel signal to the worker
*   translate_component_browser — the main orchestrator (async)
* The pure steps between the model's output and the record are exported too —
* extract_dedalo_marks, replace_dedalo_marks_with_placeholders, build_blocks,
* restore_placeholders, reorder_inverted_pairs, validate_translation and
* mark_report_lines — so they stay side-effect-free and independently testable.
*/

// imports
	import {clone, get_json_langs, is_equal} from '../../../core/common/js/utils/index.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {render_value} from '../../../core/common/js/utils/render_escape.js'
	import {tr} from '../../../core/common/js/tr.js'
	import {html_to_markdown, markdown_to_html, group_markdown_into_chunks} from './markdown_utils.js'
	import {make_placeholder, placeholder_re, extract_placeholders} from './placeholders.js'



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
* @param {string} class_name - 'error' for a refused run, 'warning' while running,
*   'success_text' for a saved one.
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
* Dédalo inline marks shielded from the model.
*
* Deliberately excludes 'html_style' (<strong>/<em>/<i>/<u>): those have native Markdown
* equivalents that html_to_markdown/markdown_to_html already round-trip, and the model
* handles Markdown emphasis far better than an opaque [[[n]]] token.
*
* 'reference' matches both halves of a reference pair (its pattern takes an optional '/').
* @type {string[]}
*/
const DEDALO_MARKS = [
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



/**
* EXTRACT_DEDALO_MARKS
* Find every Dédalo inline mark in a text, in document order, with its offsets.
*
* Two mark patterns can in principle match overlapping ranges; when they do, the
* first (and longest) match wins and the overlapped one is discarded, so a mark is
* never counted twice.
* @param {string} text - HTML string possibly containing Dédalo marks.
* @returns {Array<{start:number, end:number, mark:string}>} Sorted by start offset.
*/
export const extract_dedalo_marks = function(text) {

	const found = []
	for (let i = 0; i < DEDALO_MARKS.length; i++) {
		// tr.get_mark_pattern returns a FRESH global regex per call; matchAll copies it
		// and steps past a zero-length match, so the loop always terminates
		const pattern = tr.get_mark_pattern(DEDALO_MARKS[i])
		for (const match of text.matchAll(pattern)) {
			found.push({
				start	: match.index,
				end		: match.index + match[0].length,
				mark	: match[0]
			})
		}
	}

	// longest match first at any given offset, then drop anything it swallows
	found.sort((a, b) => (a.start - b.start) || (b.end - a.end))

	const marks = []
	let cursor = -1
	for (let i = 0; i < found.length; i++) {
		if (found[i].start < cursor) {
			continue
		}
		marks.push(found[i])
		cursor = found[i].end
	}

	return marks
}//end extract_dedalo_marks



/**
* CLASSIFY_MARK
* Decide whether a mark is one half of a paired mark or a standalone atom.
*
* index and reference marks come in pairs that wrap a span of text and share a numeric
* id — '[index-n-7-…]' … '[/index-n-7-…]'. Knowing that a token is the *close* of a
* specific *open* is what lets the repair place it deterministically when the model
* drops it. Everything else (tc, note, person, svg, geo, page, lang) stands alone.
* @param {string} mark - The raw mark string.
* @returns {{kind:string, pair_key:string|null}} kind is 'open' | 'close' | 'atom'.
*/
const classify_mark = function(mark) {

	const match = mark.match(/^\[(\/)?(index|reference)-[a-z]-([0-9]{1,6})/)
	if (!match) {
		return { kind : 'atom', pair_key : null }
	}

	return {
		kind		: match[1] ? 'close' : 'open',
		pair_key	: `${match[2]}-${match[3]}`
	}
}//end classify_mark



/**
* REORDER_INVERTED_PAIRS
* Put a paired mark back in order when translation reversed it.
*
* index and reference marks come in an open/close pair sharing an id. Translation
* reorders words, and the model can emit the close before the open, producing invalid
* markup ('[/index-n-105]…[index-n-105]'). The mark multiset is intact, so the count
* check in validate_translation does not notice.
*
* The correct order is knowable from the mark itself (the '/' says which is the close),
* so this is a deterministic fix, not a guess: for any id whose close sits before its
* open, swap the two mark strings. Whatever text lies between them is then wrapped by a
* well-formed pair — approximately the right span, and always valid markup, which an
* inverted pair is not.
*
* Every reordered pair is returned so the caller can report it: we changed what the
* model produced, and the operator must see that we did. (v6 2cd51f17c7, 2026-07-15.)
* @param {string} text - Restored HTML, marks already back in place.
* @returns {{text:string, reordered:string[]}} reordered lists the open mark of each swapped pair.
*/
export const reorder_inverted_pairs = function(text) {

	const marks = extract_dedalo_marks(text)

	// group open/close by shared id
	const groups = new Map()
	for (const item of marks) {
		const classification = classify_mark(item.mark)
		if (!classification.pair_key) {
			continue
		}
		if (!groups.has(classification.pair_key)) {
			groups.set(classification.pair_key, {})
		}
		groups.get(classification.pair_key)[classification.kind] = item
	}

	// an edit swaps the two mark strings at their original offsets
	const edits		= []
	const reordered	= []
	for (const group of groups.values()) {
		if (group.open && group.close && group.close.start < group.open.start) {
			// the close currently sits earlier — put the open string there, and vice versa
			edits.push({ start : group.close.start, end : group.close.end, replacement : group.open.mark })
			edits.push({ start : group.open.start,  end : group.open.end,  replacement : group.close.mark })
			reordered.push(group.open.mark)
		}
	}

	if (edits.length===0) {
		return { text, reordered }
	}

	// apply right-to-left so earlier offsets stay valid as lengths change
	edits.sort((a, b) => b.start - a.start)

	let out = text
	for (const edit of edits) {
		out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
	}

	return { text : out, reordered }
}//end reorder_inverted_pairs



/**
* REPLACE_DEDALO_MARKS_WITH_PLACEHOLDERS
* Substitute Dédalo inline marks with numbered [[[n]]] tokens so the LLM never sees
* (and thus cannot corrupt) them.
*
* Tokens are numbered in DOCUMENT ORDER, not grouped by mark type, so that token number
* and text position agree — which the repair and the corrective retry prompts rely on.
* @param {string} source_text - Full HTML string, possibly containing Dédalo marks.
* @returns {{safe_source_text:string, placeholders:Object, descriptors:Array}}
*   placeholders maps token → original mark string.
*   descriptors is [{ token, kind, pair_key, pair }] with pair naming the token of the other half.
*/
export const replace_dedalo_marks_with_placeholders = function(source_text) {

	const marks = extract_dedalo_marks(source_text)

	const placeholders	= {}
	const descriptors	= []

	let safe_source_text	= ''
	let cursor				= 0

	for (let i = 0; i < marks.length; i++) {
		const mark	= marks[i]
		const token	= make_placeholder(i + 1)

		safe_source_text	+= source_text.slice(cursor, mark.start) + token
		cursor				= mark.end

		placeholders[token] = mark.mark

		const classification = classify_mark(mark.mark)
		descriptors.push({
			token		: token,
			kind		: classification.kind,
			pair_key	: classification.pair_key,
			pair		: null
		})
	}
	safe_source_text += source_text.slice(cursor)

	// link the two halves of each paired mark by their shared id
	const groups = new Map()
	for (let i = 0; i < descriptors.length; i++) {
		const descriptor = descriptors[i]
		if (!descriptor.pair_key) {
			continue
		}
		if (!groups.has(descriptor.pair_key)) {
			groups.set(descriptor.pair_key, [])
		}
		groups.get(descriptor.pair_key).push(descriptor)
	}
	for (const group of groups.values()) {
		const open	= group.find(item => item.kind==='open')
		const close	= group.find(item => item.kind==='close')
		if (open && close) {
			open.pair	= close.token
			close.pair	= open.token
		} else {
			// an unmatched half has no partner to anchor against — treat it as an atom
			// so the repair does not go looking for a token that was never there
			for (const item of group) {
				item.kind = 'atom'
			}
		}
	}

	return { safe_source_text, placeholders, descriptors }
}//end replace_dedalo_marks_with_placeholders



/**
* BUILD_BLOCKS
* Turn the chunked Markdown into the block payload the worker consumes.
*
* Each chunk's tokens are renumbered to a local 1..k sequence: local single-digit ids
* are cheaper for the model to copy and more reliably reproduced than document-wide ids
* like [[[47]]]. The worker translates and repairs in local space, then maps back to the
* document-wide tokens via restore_map (block_runner.js to_global_tokens), so everything
* downstream keeps working in one namespace. (v6 d3991c3a66.)
* @param {string[]} chunks      - Markdown chunks carrying document-wide tokens.
* @param {Array}    descriptors - Document-wide descriptors from replace_dedalo_marks_with_placeholders.
* @returns {Array<{text:string, placeholders:Array, restore_map:Object}>}
*/
export const build_blocks = function(chunks, descriptors) {

	const by_token = new Map(descriptors.map(item => [item.token, item]))

	return chunks.map(function(chunk){

		// global token → local token, in order of appearance within this chunk
		const local_of = new Map()
		const tokens = extract_placeholders(chunk)
		for (let i = 0; i < tokens.length; i++) {
			if (!local_of.has(tokens[i])) {
				local_of.set(tokens[i], make_placeholder(local_of.size + 1))
			}
		}

		// single pass, so a rewritten token can never be rewritten again
		const text = chunk.replace(placeholder_re(), (match) => local_of.get(match) || match)

		const block_placeholders	= []
		const restore_map			= {}
		for (const [global_token, local_token] of local_of) {

			restore_map[local_token] = global_token

			const descriptor = by_token.get(global_token)
			// the other half of a pair may have landed in a different chunk; within this
			// block it has no anchor, so it behaves as an atom
			const pair_local = descriptor?.pair
				? local_of.get(descriptor.pair)
				: null

			block_placeholders.push({
				token	: local_token,
				kind	: pair_local ? descriptor.kind : 'atom',
				pair	: pair_local || null
			})
		}

		return {
			text			: text,
			placeholders	: block_placeholders,
			restore_map		: restore_map
		}
	})
}//end build_blocks



/**
* RESTORE_PLACEHOLDERS
* Put the original Dédalo marks back where their tokens ended up.
*
* Two model artefacts are handled here rather than being written to the record:
*   - a DUPLICATED token. Emitting the mark twice would produce broken markup (two
*     opens for one close), so only the first occurrence becomes a mark and the rest
*     are dropped.
*   - an INVENTED token ([[[99]]] when only 12 marks exist). It maps to nothing, and
*     leaving it in place would save the literal text '[[[99]]]' into the component.
* Both are returned so the caller can report them.
*
* A token absent from the text restores nothing — validate_translation counts its mark
* as missing and the run is refused.
* @param {string} translated_text - Text from the model, carrying document-wide tokens.
* @param {Object} placeholders    - token → original mark string.
* @returns {{text:string, duplicated:string[], residual:string[]}}
*/
export const restore_placeholders = function(translated_text, placeholders) {

	const known		= new Set(Object.keys(placeholders))
	const residual	= extract_placeholders(translated_text).filter(token => !known.has(token))

	const duplicated = []

	let text = translated_text
	for (const [token, mark] of Object.entries(placeholders)) {

		const first = text.indexOf(token)
		if (first===-1) {
			continue
		}

		text = text.slice(0, first) + mark + text.slice(first + token.length)

		if (text.indexOf(token)!==-1) {
			duplicated.push(mark)
			text = text.split(token).join('')
		}
	}

	// strip whatever tokens are left: by construction they map to no mark at all
	if (residual.length>0) {
		text = text.replace(placeholder_re(), '')
	}

	return { text, duplicated, residual }
}//end restore_placeholders



/**
* VALIDATE_TRANSLATION
* Account for every Dédalo mark between the source value and the translated one.
*
* The invariant that matters is that the set of marks is preserved exactly: the
* translation may reorder them (word order changes between languages) but it must not
* drop, invent or duplicate one. A dropped index mark silently breaks a thesaurus link;
* an invented one links text to something the source never linked.
*
* Anything the MODEL did not place — a token it dropped that we re-inserted, a pair we
* put back in order, a duplicate or invented token we removed — is counted too: we may
* have put it in the right place, but we chose it.
*
* Lost blocks are not counted here: translate_component_browser refuses a run that
* lost a block before it gets this far (REFUSAL 1).
* @param {string} source_text   - The original HTML value (marks intact).
* @param {string} restored_text - The translated HTML value, marks restored and reordered.
* @param {Object} extra         - { duplicated, residual, repaired, unrepairable, reordered }
* @returns {Object} report:
*   missing / added   — marks in the source but not the result, and the reverse
*   unrepairable      — marks the worker could not place (appended, position unknown)
*   repaired / reordered / duplicated / residual — what WE changed
*   total_marks       — marks in the source
*   refused           — true when a mark is missing, added or unplaceable: NOT saveable
*   uncertain_count   — repaired + reordered + duplicated + residual (saved, reported)
*/
export const validate_translation = function(source_text, restored_text, extra) {

	const source_marks = extract_dedalo_marks(source_text).map(item => item.mark)
	const result_marks = extract_dedalo_marks(restored_text).map(item => item.mark)

	const counts = new Map()
	for (const mark of source_marks) {
		counts.set(mark, (counts.get(mark) || 0) + 1)
	}
	for (const mark of result_marks) {
		counts.set(mark, (counts.get(mark) || 0) - 1)
	}

	const missing	= []
	const added		= []
	for (const [mark, delta] of counts) {
		for (let i = 0; i < delta; i++) {
			missing.push(mark)
		}
		for (let i = 0; i < -delta; i++) {
			added.push(mark)
		}
	}

	const report = {
		missing			: missing,
		added			: added,
		duplicated		: extra?.duplicated || [],
		residual		: extra?.residual || [],
		repaired		: extra?.repaired || [],
		unrepairable	: extra?.unrepairable || [],
		reordered		: extra?.reordered || [],
		total_marks		: source_marks.length
	}

	// A mark that is gone, that the source never had, or that nobody could place is not
	// a translation the record can take: the run is REFUSED (owner ruling A1-02 — v6
	// asked the operator to accept or discard; TS never saves it).
	report.refused =
		report.missing.length>0 ||
		report.added.length>0 ||
		report.unrepairable.length>0

	// marks whose final position or presence WE decided, rather than the model
	report.uncertain_count =
		report.repaired.length +
		report.reordered.length +
		report.duplicated.length +
		report.residual.length

	return report
}//end validate_translation



/**
* MARK_REPORT_LINES
* The operator-facing account of what happened to the marks, one line per kind.
* Used both for a refused run (under 'translation_review_needed') and for a run saved
* with marks we placed (under 'translation_saved_with_warnings').
* @param {Object} report - validate_translation() output.
* @param {Function} get_label - (key, ...args) => string|null; the tool label resolver.
* @returns {string[]}
*/
export const mark_report_lines = function(report, get_label) {

	const lines = []

	// marks that are simply gone, or that nobody could find a place for
	const unplaced = report.missing.length + report.unrepairable.length
	if (unplaced>0) {
		lines.push(
			get_label('marks_unplaced', unplaced)
			|| `${unplaced} marks could not be placed`
		)
	}

	// marks in the translation that the source does not have
	if (report.added.length>0) {
		lines.push(
			get_label('marks_invented', report.added.length)
			|| `${report.added.length} marks that are not in the source text appeared in the translation`
		)
	}

	// marks we re-inserted ourselves: present, but WE chose the position
	if (report.repaired.length>0) {
		lines.push(
			get_label('marks_repositioned', report.repaired.length, report.total_marks)
			|| `${report.repaired.length} of ${report.total_marks} marks were repositioned automatically`
		)
	}

	// paired marks the translation reversed, which we put back in open→close order
	if (report.reordered.length>0) {
		lines.push(
			get_label('marks_reordered', report.reordered.length)
			|| `${report.reordered.length} linked marks were reversed by the translation and reordered`
		)
	}

	// markers the model duplicated or invented, dropped before saving
	const invalid = report.residual.length + report.duplicated.length
	if (invalid>0) {
		lines.push(
			get_label('marks_removed_invalid', invalid)
			|| `${invalid} invalid markers were removed`
		)
	}

	return lines
}//end mark_report_lines



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
* SAVE_LANDED
* Whether a component_common save() answer means the translated entry IS STORED.
* save() never rejects, so its answer is the only evidence:
*  - an envelope: stored unless request_failed (the server refused or the
*    transport failed — both resolve a failure envelope);
*  - `false`: save() sent nothing. That is a success only when the value was
*    ALREADY stored — the no-change exit, decided by the same comparison save()
*    makes (the entry against db_data's entry of the same id). Every other
*    `false` (page identity revoked, already saving, superseded) wrote nothing.
* Measures the outcome, never which internal exit save() took.
* @param {Object} target_component - the instance that was saved
* @param {Object|boolean} save_response - what save() resolved
* @param {Object} entry - the entry that was sent ({id?, value})
* @return {boolean}
*/
const save_landed = function(target_component, save_response, entry) {

	if (save_response===false || save_response===undefined || save_response===null) {
		const entry_id = entry?.id
		if (entry_id===undefined || entry_id===null) {
			return false
		}
		const stored = target_component.db_data?.entries?.find(item => item?.id===entry_id)
		return stored!==undefined && is_equal(entry, stored)
	}

	return !request_failed(save_response)
}//end save_landed



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
* Refusal on a mark that cannot be accounted for (A1-02):
*   validate_translation counts the Dédalo marks of the final value against the
*   source. A mark that is missing, one the source does not have, or one the worker
*   reported as unplaceable refuses the run the same way (nothing saved, the
*   target's own data put back, 'translation_review_needed' + the per-kind lines in
*   the status area, the Promise REJECTS). Marks we re-inserted, reordered or
*   de-duplicated are saved, and the resolve says so: msg 'OK. Translation saved
*   with warnings' and the status area lists them.
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
* @param {Function}      [options.get_label]                - Tool label resolver: (key, ...args) => string
*                                                             (args fill the label's %s slots).
*                                                             Defaults to identity (key => key).
* @returns {Promise<{result: boolean, msg: string}>}
*   Resolves {result:true} only on a COMPLETE translation whose save ANSWERED
*   that the value is stored (save_landed), and {result:false} on user
*   cancellation (nothing saved — callers must treat any result other than true
*   as not done); rejects on fatal worker errors, empty source text, an
*   incomplete run or an unaccounted mark — see "Refusal" above — and a save
*   that did not land. Rejection (not a resolve carrying result:false) is
*   load-bearing: tool_lang_multi's automatic_translation_all counts every
*   resolved promise as ok in its (n/total) summary — so a resolve here would
*   report success for a run that saved nothing. The status area is this
*   driver's alone: tool_lang's click handler no longer paints over it (it would
*   erase a refusal or the saved-with-warnings account).
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

	// shield the Dédalo marks from the model: [[[n]]] tokens in document order, each
	// classified as the open/close half of a pair or a standalone atom (the repair needs it)
		const { safe_source_text, placeholders, descriptors } = replace_dedalo_marks_with_placeholders(clean_source_text)

	// convert HTML to markdown for the LLM
		const md_source_text = html_to_markdown(safe_source_text)

	// parse markdown into chunks
	// The worker translates one chunk at a time; the 1000-char limit keeps each
	// block well within the model's MAX_NEW_TOKENS=2048 budget.
		const chunks = group_markdown_into_chunks(md_source_text, 1000)

	// one block per chunk, its tokens renumbered locally (see build_blocks)
		const blocks = build_blocks(chunks, descriptors)

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
		* Rejecting (instead of resolving with result:false) is load-bearing:
		* tool_lang_multi's automatic_translation_all counts every resolved promise
		* as ok in its (n/total) summary, and tool_lang's click handler treats a
		* resolve as a finished run. A resolve here would report success for a run
		* that saved nothing.
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

		/**
		* FAIL_SAVE
		* The translation was complete but its save did not land. Unlike refuse_run,
		* the target data is NOT put back: component_common's save() registered the
		* edit as unsaved (marks + failed_changed_data), and its retry/unsaved-data
		* guard owns it from here. Names the failure (TEXT only, DS-1) and rejects —
		* a resolve would be counted as ok by both callers.
		* @param {Array<string>} lines - operator-facing message, one line each.
		* @return void
		*/
		const fail_save = function(lines) {

			if (status_container) {
				status_container.classList.remove('loading_status')
				status_container.replaceChildren(status_lines_node('error', lines))
			}

			reject(new Error(lines.join(' ')))
		}//end fail_save

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
					// marks restored for the preview; the decision on them is taken at 'end'
					const html_accumulated = restore_placeholders(markdown_to_html(accumulated_text), placeholders).text
					if (!target_component.data.value) {
						target_component.data.value = []
					}
					target_component.data.value[0] = html_accumulated
					if (streaming_overlay_content) {
						// Mirror the partial result into the streaming overlay so the
						// user sees live output even before the component re-renders.
						// Machine translation of record text: rendered by the TARGET
						// component's server class (text_area 'html' passes, anything
						// else is escaped) — the ONE escaper, render_escape_tripwire.
						streaming_overlay_content.innerHTML = render_value(html_accumulated, target_component.context?.render_class)
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

					// markdown -> HTML, then restore the Dédalo marks (duplicated and
					// invented tokens are dropped here and reported)
					const translated_html	= markdown_to_html(translated_md)
					const restored			= restore_placeholders(translated_html, placeholders)

					// translation can reverse a paired mark (close before open) — put it
					// back in order before validating and saving, and report it
					const ordered		= reorder_inverted_pairs(restored.text)
					const restored_text	= ordered.text

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

					// REFUSAL 3 — a mark could not be accounted for.
					// Every source mark must come back exactly once. The worker re-inserts
					// the tokens the model dropped (block_runner.js → repair_placeholders) and
					// names any it could not place; this check does not trust that alone —
					// it counts the marks of the final value against the source. A mark
					// that is gone, invented or unplaceable is never written: the target
					// language would lose an index/tc/svg link with the run reported done.
					const repair_stats	= data.repair_stats || {}
					const report		= validate_translation(clean_source_text, restored_text, {
						duplicated		: restored.duplicated,
						residual		: restored.residual,
						repaired		: repair_stats.repaired || [],
						unrepairable	: repair_stats.unrepairable || [],
						reordered		: ordered.reordered
					})
					const mark_lines = mark_report_lines(report, get_label)
					if (report.refused) {
						refuse_run([
							get_label('translation_review_needed') || 'Translation needs review before saving',
							...mark_lines,
							get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.',
							get_label('translation_retry') || 'Run the translation again to retry.'
						])
						break;
					}

					// complete run: every block translated and the result is not empty.
					// (!) NOT 'completed' yet: that is only true once the save has
					// answered that the value is stored (see save_landed below).
					if (streaming_overlay) {
						streaming_overlay.classList.add('hide')
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
					// THE OUTCOME IS WHAT THE SAVE ANSWERED (T1-P01). component_common's
					// save() never rejects: a failed save RESOLVES its failure envelope and
					// every pre-wire refusal (page identity revoked, already saving,
					// superseded) resolves `false`. Waiting for the call to return reported
					// a translation that was never stored as completed, and tool_lang_multi
					// counted it ok. The failed edit is NOT restored here: save() already
					// registered it as unsaved data (register_failed_save + the
					// 'modified'/'error' marks), and that registration is what a retry or
					// the unsaved-data guard works from.
					Promise.resolve()
					.then(function(){
						return target_component.save([save_item])
					})
					.then(function(save_response){
						if (!save_landed(target_component, save_response, entry)) {
							const lines = [
								get_label('translation_save_failed') || 'Translation not saved: the save failed'
							]
							if (request_failed(save_response)) {
								lines.push(error_text(save_response.error))
							}
							lines.push(get_label('translation_retry') || 'Run the translation again to retry.')
							fail_save(lines)
							return
						}
						// marks WE placed (repositioned, reordered, removed) are saved but
						// never reported as a clean completion: the operator checks them
						const with_warnings = report.uncertain_count > 0
						if (status_container) {
							status_container.classList.remove('loading_status')
							status_container.replaceChildren(with_warnings
								? status_lines_node('warning', [
									get_label('translation_saved_with_warnings') || 'Translation saved — check the marks',
									...mark_lines
								])
								: status_lines_node('success_text', [
									get_label('translation_completed') || 'Translation completed'
								])
							)
						}
						resolve(with_warnings
							? {result: true, msg: 'OK. Translation saved with warnings'}
							: {result: true, msg: 'OK. Translation completed'})
						// the value is stored: a failed repaint does not change that outcome
						Promise.resolve()
						.then(function(){
							return target_component.refresh({
								build_autoload : false
							})
						})
						.catch(function(refresh_error){
							console.error('Refresh failed after a saved translation:', refresh_error)
						})
					})
					.catch(function(save_error){
						// a throwing save door (not component_common's): nothing is known stored
						console.error('Save failed after translation:', save_error)
						fail_save([
							get_label('translation_save_failed') || 'Translation not saved: the save failed',
							String(save_error?.message || save_error || ''),
							get_label('translation_retry') || 'Run the translation again to retry.'
						].filter(Boolean))
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
						const preview = restore_placeholders(markdown_to_html(data.accumulated_text), placeholders).text
						streaming_overlay_content.innerHTML = render_value(preview, target_component.context?.render_class)
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
						status_container.textContent = get_label('translation_cancelled') || 'Translation cancelled'
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
