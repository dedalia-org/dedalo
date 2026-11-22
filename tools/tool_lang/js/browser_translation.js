// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* SHARED BROWSER TRANSLATION ENGINE
* Client-side AI translation orchestration shared by tool_lang and tool_lang_multi.
*
* Runs a translation model entirely in the browser through the Web Worker at
* tools/tool_lang/translators/browser_transformer/browser_transformer.js (HuggingFace
* Transformers + ONNX runtime). WHICH model is the operator's choice from the tool config's
* catalogue (register.json → browser_transformer.models; fallback copy and field list in
* browser_models.js): Qwen3, TranslateGemma, NLLB, MADLAD-400 or opus-mt (v6 40bf5eaacf +
* 23010156ad).
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
*   1. Refuse a component not in 'edit' mode (v6), an empty source, and a source whose own
*      text looks like a [[[n]]] token (it would be read back as one).
*   2. Replace Dédalo inline marks (index, tc, svg, …) with [[[n]]] tokens (placeholders.js)
*      in document order, classified as the open/close half of a pair or an atom; convert
*      the HTML to Markdown (html_to_markdown), every tag without a Markdown form SHIELDED
*      behind tokens as well — the model never sees markup (source_to_markdown).
*   3. Segment the Markdown (segment_markdown, ≤250 chars, v6 55c816b41c), balance each
*      segment's emphasis, hoist the tokens at its edges out of the model input and
*      renumber the rest locally (build_blocks).
*   4. Post the blocks + lang codes + the model definition to the shared worker. The worker
*      (block_runner.js) translates segment by segment — the model receives the segment and
*      nothing else (v6 92da452aa1: it cannot be instructed) — retries a looping one with a
*      stiffer penalty then sampling, normalises the tokens the model mangled, removes the
*      ones it invented, re-inserts the ones it dropped (repair_placeholders) and re-attaches
*      the hoisted ones, naming in repair_stats every token IT placed or removed.
*   5. Stream 'on_chunk' partial results (marks restored) into the target component's DOM.
*   6. On 'end' AND ONLY when every block translated: Markdown → HTML with every character
*      the model wrote ESCAPED, every token restored exactly once, inverted pairs put back in
*      order, every mark accounted for against the source, no mark outside the text, no
*      repetition loop (validate_translation) — then save() + refresh(). Positions WE chose
*      are saved and reported ('translation_saved_with_warnings'), never as a clean
*      completion (owner ruling Q2, 2026-11-22).
*   7. Otherwise the run is REFUSED (audit row A1-02 and its review): nothing is saved, the
*      target component's pre-run data is put back, the reason is named in the status area
*      and the returned Promise REJECTS. Saving it would overwrite the target language's
*      existing — possibly human-made — text with a damaged machine translation.
*   A worker 'error' with a code (no_model / unsupported_lang / unsupported_pair /
*   needs_webgpu / model_too_large) is a SOFT error: the run resolves {result:false} with the
*   worker's advice (v6). No model offered, or a source/target language with no locale code,
*   is refused the same soft way BEFORE the worker starts (A1-02 re-review: no fallback model,
*   no 'en' fallback language).
*
* Real-model behaviour is NOT exercised by any gate (no GPU in CI): the client suite drives
* this file and block_runner.js with a scripted model. The manual check is in the tool's
* developer reference.
*
* Exports:
*   get_browser_worker          — lazy-initialise the shared Worker
*   dispose_browser_worker      — terminate and null the shared Worker
*   cancel_browser_translation  — post a cancel signal to the worker
*   translate_component_browser — the main orchestrator (async)
* The pure steps between the source and the record are exported too —
* extract_dedalo_marks, replace_dedalo_marks_with_placeholders, source_has_token_shaped_text,
* source_to_markdown, build_blocks, reorder_inverted_tokens, restore_placeholders,
* reorder_inverted_pairs, validate_translation and mark_report_lines — so they stay
* side-effect-free and independently testable.
*/

// imports
	import {clone, get_json_langs, is_equal} from '../../../core/common/js/utils/index.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {render_value} from '../../../core/common/js/utils/render_escape.js'
	import {tr} from '../../../core/common/js/tr.js'
	import {html_to_markdown, markdown_to_html, marks_in_text_nodes, segment_markdown} from './markdown_utils.js'
	import {extract_placeholders, has_token_shaped_text, make_placeholder, normalize_placeholders, placeholder_re} from './placeholders.js'



/**
* Segment size handed to the model, in characters (v6 55c816b41c; see translate_component_browser).
* @type {number}
*/
const SEGMENT_MAX_CHARS = 250



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
* Set by cancel_browser_translation, cleared when a run starts. The worker checks its own
* flag before every block and again before 'end'; this one covers the last gap — an 'end'
* the worker posted just before the cancel reached it is treated as a cancellation, never
* saved.
* @type {boolean}
*/
let cancel_requested = false



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
* repeated calls avoids re-downloading and re-compiling the multi-GB ONNX
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
* 'cancelled' handler puts the component's own value back before resolving. A
* cancel during the LAST block is still a cancellation: the worker re-checks before
* 'end', and an 'end' already in flight is not saved (cancel_requested).
* @returns {boolean} Always true (the signal is fire-and-forget).
*/
export const cancel_browser_translation = function() {

	cancel_requested = true

	if (shared_worker) {
		shared_worker.postMessage({ cancel : true })
	}

	return true
}//end cancel_browser_translation



/**
* DEDALO_TO_LOCALE
* Convert a Dédalo lang code (e.g. 'lg-eng') to a BCP 47 base-language locale
* code (e.g. 'en') expected by the worker's models.
*
* The conversion uses the `locale` field of the matching entry in `json_langs`
* (the platform's language registry). Only the primary-language subtag is kept
* (everything before the first '-' in a full locale like 'en-US') because
* the worker's language tables expect short codes ('en', 'es', 'fr', …).
*
* NO FALLBACK (A1-02 re-review): an unknown Dédalo code, or an entry without a `locale`
* (lg-nolan, a language the registry does not map), is null and the caller REFUSES the
* run. The old 'en' fallback translated such a language as English — and saved the result
* as the target language's text.
* @param {string} dedalo_lang - Dédalo internal lang identifier, e.g. 'lg-eng'.
* @param {Array}  json_langs  - Array of lang-registry objects, each with at
*                               minimum { dd_lang: string, locale: string }.
*                               Obtained via get_json_langs() or options.json_langs.
* @returns {string|null} Short locale code ('en', 'es', 'fr', …), or null when unmapped.
*/
const dedalo_to_locale = function(dedalo_lang, json_langs) {

	const lang_obj = json_langs.find(item => item.dd_lang===dedalo_lang)
	const short = typeof lang_obj?.locale==='string'
		? lang_obj.locale.split('-')[0].trim()
		: ''

	return short || null
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
* Tokens are numbered in DOCUMENT ORDER, not grouped by mark type. (The tags
* source_to_markdown shields are numbered after the marks; what the model sees is each
* block's tokens renumbered in order of appearance — build_blocks.)
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
* SOURCE_HAS_TOKEN_SHAPED_TEXT
* Does the source's own text contain something the pipeline would read as a [[[n]]] token?
*
* Tokens share their namespace with the record's text: a literal '[[[2]]]', '[[2]]' or
* '[[[ 2 ]]]' typed by a person would be normalised into the token [[[2]]] on the way back
* and take mark 2's place, or duplicate it. Such a source cannot be translated safely with
* bracket tokens, so the run is refused before the model starts (A1-02 review; the token
* form stays the v6 one — it is the form the models were shown to copy). The Dédalo marks
* themselves are removed first: their own brackets are not text.
* @param {string} source_text - The source HTML, marks intact.
* @returns {boolean}
*/
export const source_has_token_shaped_text = function(source_text) {

	const marks = extract_dedalo_marks(source_text)

	let text	= ''
	let cursor	= 0
	for (const mark of marks) {
		text	+= source_text.slice(cursor, mark.start) + ' '
		cursor	= mark.end
	}
	text += source_text.slice(cursor)

	// NOT has_token_shaped_text(): that one skips the canonical [[[n]]] as a real token,
	// and the source has none yet — a literal '[[[3]]]' typed by a person is exactly the
	// collision this guards
	return extract_placeholders(normalize_placeholders(text)).length > 0
}//end source_has_token_shaped_text



/**
* SOURCE_TO_MARKDOWN
* The source HTML as the Markdown the model receives, with everything it must not touch
* turned into [[[n]]] tokens:
*   - the Dédalo marks (replace_dedalo_marks_with_placeholders), numbered first;
*   - every element with no Markdown form — <span style>, <sup>, <a href>, <img>, a table
*     with merged cells, anything unknown — through html_to_markdown's shield callback:
*     a start tag is an 'open' token, its end tag the paired 'close', a void or raw element
*     an 'atom'. The tag is restored like a mark — as the browser serialises it from the
*     source (DOMParser + outerHTML: attribute quoting and entities normalised, not a byte
*     copy of the stored string) — so the model never sees (and cannot corrupt, or forge)
*     markup, and markdown_to_html can escape everything it wrote (A1-02 review).
*     Headings, lists, quotes, rules, tables and <div> are shielded too: block structure
*     comes from the source, never from Markdown syntax the model writes (A1-02 re-review).
* @param {string} source_text - The source HTML (marks intact, &nbsp; already cleaned).
* @returns {{md:string, placeholders:Object, descriptors:Array, block_tokens:Set<string>}}
*   placeholders: token → what it restores (a mark's bytes, or a serialised tag); descriptors: one per token,
*   shield tokens flagged `shield: true`; block_tokens: the tokens of block-level tags.
*/
export const source_to_markdown = function(source_text) {

	const { safe_source_text, placeholders, descriptors } = replace_dedalo_marks_with_placeholders(source_text)

	const block_tokens = new Set()
	const by_token = new Map(descriptors.map(item => [item.token, item]))

	const shield = function(request) {

		const token = make_placeholder(descriptors.length + 1)

		placeholders[token] = request.html

		const descriptor = {
			token		: token,
			kind		: request.kind,
			pair_key	: null,
			pair		: request.pair || null,
			shield		: true
		}
		descriptors.push(descriptor)
		by_token.set(token, descriptor)

		// the open half learns its close
		if (request.kind==='close' && request.pair && by_token.has(request.pair)) {
			by_token.get(request.pair).pair = token
		}
		if (request.block) {
			block_tokens.add(token)
		}

		return token
	}

	const md = html_to_markdown(safe_source_text, { shield })

	return { md, placeholders, descriptors, block_tokens }
}//end source_to_markdown



/**
* Paired Markdown emphasis delimiters, longest first so that '**' is matched before '*'.
* @type {string[]}
*/
const MD_DELIMITERS = ['**', '__', '*']



/**
* BALANCE_MARKDOWN_CHUNKS
* Make every chunk self-contained: close any emphasis run left open at the end of a chunk,
* and reopen it at the start of the next. (v6 55c816b41c)
*
* A chunk is a whole model input; handing the model '**Line one' — an opening delimiter
* with no partner — is handing it broken Markdown. segment_markdown prefers paragraph and
* line boundaries, so this rarely triggers; it still can when a paragraph is cut at a
* sentence.
*   in :  ['**Line one', 'Line two**']
*   out:  ['**Line one**', '**Line two**']
* @param {string[]} chunks - Markdown chunks, in document order.
* @returns {string[]}
*/
const balance_markdown_chunks = function(chunks) {

	// delimiters left open when the previous chunk ended, innermost last
	let carried = []

	return chunks.map(function(chunk){

		const text = carried.join('') + chunk

		const open = []
		for (let i = 0; i < text.length; i++) {

			// a backslash-escaped '\*' / '\_' is text, not a delimiter
			if (text[i]==='\\') {
				i++
				continue
			}

			const delimiter = MD_DELIMITERS.find(item => text.startsWith(item, i))
			if (!delimiter) {
				continue
			}

			const position = open.lastIndexOf(delimiter)
			if (position===-1) {
				open.push(delimiter)
			}else{
				open.splice(position, 1)
			}
			i += delimiter.length - 1
		}

		// close what is still open, innermost first, and carry it into the next chunk
		carried = open.slice()

		return text + open.slice().reverse().join('')
	})
}//end balance_markdown_chunks



/**
* HOIST_EDGE_PLACEHOLDERS
* Pull the markers off the front and back of a chunk so the model never sees them.
* (v6 55c816b41c)
*
* The most reliable way to stop the model corrupting a marker is not to show it one. A
* Dédalo mark overwhelmingly sits at a segment edge — a timecode opening a segment, an index
* close ending one — and an edge marker's position in the translation is not in question.
* Whitespace between the edge markers and the body stays with the marker, so
* prefix + body + suffix reproduces the chunk exactly. A chunk made ENTIRELY of markers is
* left whole (block_runner.js returns it without a model call).
* @param {string} chunk - Markdown chunk carrying document-wide [[[n]]] tokens.
* @returns {{prefix:string, body:string, suffix:string}}
*/
const hoist_edge_placeholders = function(chunk) {

	const leading	= chunk.match(/^(?:\s*\[\[\[\d+\]\]\])+\s*/)
	const prefix	= leading ? leading[0] : ''

	let body = chunk.slice(prefix.length)

	const trailing	= body.match(/\s*(?:\[\[\[\d+\]\]\]\s*)+$/)
	const suffix	= trailing ? trailing[0] : ''

	body = body.slice(0, body.length - suffix.length)

	if (body.trim().length===0) {
		return { prefix : '', body : chunk, suffix : '' }
	}

	return { prefix, body, suffix }
}//end hoist_edge_placeholders



/**
* BUILD_BLOCKS
* Turn the segmented Markdown into the block payload the worker consumes. (v6 55c816b41c)
*
* Chunks are balanced first (no chunk reaches the model with a dangling emphasis
* delimiter), their edge markers HOISTED out of the model input, and the tokens left in the
* body renumbered to a local 1..k sequence: local single-digit ids are cheaper for the model
* to copy than document-wide ones like [[[47]]]. The worker translates and repairs in local
* space and maps back to document-wide tokens via restore_map (block_runner.js
* to_global_tokens); the hoisted prefix/suffix are document-wide already.
*
* Each block carries the `sep` of its segment — the literal text that preceded it in the
* source — and the worker rejoins with it: a hardcoded '\n\n' turned a record of one <p>
* with four <br> into twenty-five <p>.
* @param {Array<{text:string, sep:string}>} segments - from segment_markdown.
* @param {Array} descriptors - Document-wide descriptors (source_to_markdown).
* @returns {Array<{text:string, placeholders:Array, restore_map:Object, prefix:string, suffix:string, sep:string}>}
*/
export const build_blocks = function(segments, descriptors) {

	const by_token = new Map(descriptors.map(item => [item.token, item]))

	const balanced = balance_markdown_chunks(segments.map(item => item.text))

	return balanced.map(function(chunk, index){

		const hoisted = hoist_edge_placeholders(chunk)

		// global token → local token, in order of appearance within the body
		const local_of = new Map()
		const tokens = extract_placeholders(hoisted.body)
		for (let i = 0; i < tokens.length; i++) {
			if (!local_of.has(tokens[i])) {
				local_of.set(tokens[i], make_placeholder(local_of.size + 1))
			}
		}

		// single pass, so a rewritten token can never be rewritten again
		const text = hoisted.body.replace(placeholder_re(), (match) => local_of.get(match) || match)

		const block_placeholders	= []
		const restore_map			= {}
		for (const [global_token, local_token] of local_of) {

			restore_map[local_token] = global_token

			const descriptor = by_token.get(global_token)
			// the other half of a pair may have landed in a different chunk or been hoisted
			// out of this one: with no anchor here, it behaves as an atom
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
			restore_map		: restore_map,
			prefix			: hoisted.prefix,
			suffix			: hoisted.suffix,
			sep				: segments[index].sep
		}
	})
}//end build_blocks



/**
* REORDER_INVERTED_TOKENS
* Put a shielded tag pair back in order when translation reversed it: the end tag's token
* before its start tag's ('</span>…<span style>') is invalid markup. The order is knowable
* from the descriptors, so this is a deterministic swap, reported like a reordered mark pair
* (reorder_inverted_pairs does the same for the Dédalo marks, after they are restored).
* @param {string} text - Translated Markdown, document-wide tokens.
* @param {Array} descriptors - source_to_markdown descriptors.
* @returns {{text:string, reordered:string[]}} reordered lists the open token of each swapped pair.
*/
export const reorder_inverted_tokens = function(text, descriptors) {

	const edits		= []
	const reordered	= []
	for (const descriptor of descriptors) {
		if (!descriptor.shield || descriptor.kind!=='open' || !descriptor.pair) {
			continue
		}
		const open_at	= text.indexOf(descriptor.token)
		const close_at	= text.indexOf(descriptor.pair)
		if (open_at===-1 || close_at===-1 || close_at > open_at) {
			continue
		}
		edits.push({ start : close_at, end : close_at + descriptor.pair.length, replacement : descriptor.token })
		edits.push({ start : open_at,  end : open_at + descriptor.token.length, replacement : descriptor.pair })
		reordered.push(descriptor.token)
	}

	// right to left, so earlier offsets stay valid
	edits.sort((a, b) => b.start - a.start)

	let out = text
	for (const edit of edits) {
		out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
	}

	return { text : out, reordered }
}//end reorder_inverted_tokens



/**
* RESTORE_PLACEHOLDERS
* Put the original bytes (Dédalo marks, shielded tags) back where their tokens ended up.
*
* Every token must be present EXACTLY ONCE, and nothing is guessed here:
*   - a DUPLICATED token: every copy is removed and it is reported — which copy is the
*     right one is unknowable, and keeping the first (v6) would put the mark at a guessed
*     place while reporting it as present;
*   - a MISSING token: reported (its mark is then missing, its tag pair unbalanced);
*   - a STRAY token ([[[99]]] when only 12 exist): removed and reported — it maps to
*     nothing, and left in it would be saved as the literal text '[[[99]]]'.
* The worker already guarantees each block's tokens exactly once, so on this side any of
* the three means an invariant broke: the caller refuses the run.
* @param {string} translated_text - Text carrying document-wide tokens.
* @param {Object} placeholders    - token → original bytes.
* @returns {{text:string, duplicated:string[], missing:string[], residual:string[]}} tokens.
*/
export const restore_placeholders = function(translated_text, placeholders) {

	const counts = new Map()
	for (const token of extract_placeholders(translated_text)) {
		counts.set(token, (counts.get(token) || 0) + 1)
	}

	const duplicated	= []
	const missing		= []
	const residual		= []
	for (const token of Object.keys(placeholders)) {
		const count = counts.get(token) || 0
		if (count===0) {
			missing.push(token)
		}else if (count > 1) {
			duplicated.push(token)
		}
	}
	for (const token of counts.keys()) {
		if (!Object.hasOwn(placeholders, token)) {
			residual.push(token)
		}
	}

	// single pass: a restored mark can never be read as a token again
	const drop = new Set([...duplicated, ...residual])
	const text = translated_text.replace(placeholder_re(), (token) => drop.has(token)
		? ''
		: placeholders[token])

	return { text, duplicated, missing, residual }
}//end restore_placeholders



/**
* COUNT_EMPHASIS_LOST
* How many inline formatting spans the translation dropped (opening tags only; a negative
* delta — emphasis added — is reported as zero). REPORTED, never a reason to refuse: losing
* an <em> is cosmetic, and treating it like a lost mark would make every run need review.
* (v6 55c816b41c)
* @param {string} source_text
* @param {string} restored_text
* @returns {number}
*/
const count_emphasis_lost = function(source_text, restored_text) {

	const pattern = /<(strong|b|em|i|u)\b[^>]*>/gi

	const source_count	= (source_text.match(pattern) || []).length
	const result_count	= (restored_text.match(pattern) || []).length

	return Math.max(0, source_count - result_count)
}//end count_emphasis_lost



/**
* A translation is roughly as long as its source; past this multiple of the source's
* plain-text length it is not a translation (v6; block_runner.js applies the same ratio per
* block).
* @type {number}
*/
const MAX_LENGTH_RATIO = 2.5



/**
* IS_DEGENERATE
* Has the model produced a repetition loop rather than a translation? (v6 55c816b41c)
*
* The last line of defence, and the only one that does not depend on a heuristic having
* fired upstream: arithmetic on the plain text (markup and Dédalo marks removed, so a long
* index mark does not distort the ratio). Sources under 20 characters are not judged.
* @param {string} source_text   - The original HTML value.
* @param {string} restored_text - The translated HTML value.
* @returns {boolean}
*/
const is_degenerate = function(source_text, restored_text) {

	const plain = (html) => html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()

	const source_length = plain(source_text).length
	if (source_length < 20) {
		return false
	}

	return plain(restored_text).length > source_length * MAX_LENGTH_RATIO
}//end is_degenerate



/**
* VALIDATE_TRANSLATION
* Account for every Dédalo mark and every shielded tag between the source value and the
* translated one, and decide whether the result may be saved.
*
* The marks are counted directly — the multiset of marks must be preserved exactly (the
* translation may move them, never drop, invent or duplicate one): a dropped index mark
* silently breaks a thesaurus link. Shielded tags are accounted for by their tokens.
*
* REFUSED (nothing saved — audit row A1-02 and its review; v6 d3991c3a66 offered the
* operator an accept/discard choice instead, owner ruling Q2 2026-11-22 keeps the TS
* split):
*   missing / added       — marks the result lacks, or has that the source does not
*   unrepairable          — tokens the worker could not place (position unknown)
*   duplicated            — tokens the model wrote more than once (every copy removed)
*   tags_missing          — shielded tags whose token did not come back
*   stray                 — main-thread tokens that map to nothing
*   outside_text          — marks that ended up inside markup rather than text
*   degenerate            — the result is a repetition loop (is_degenerate)
* SAVED WITH WARNINGS (Q2: save-with-warning, no accept/discard step):
*   repaired / reordered  — positions WE chose
*   residual              — tokens the model invented, removed
* REPORTED ONLY: emphasis_lost.
* @param {string} source_text   - The original HTML value (marks intact).
* @param {string} restored_text - The translated HTML value, restored and reordered.
* @param {Object} extra         - { repaired, unrepairable, duplicated, residual, reordered,
*   tags_missing, stray, outside_text }
* @returns {Object} the report; `refused` and `uncertain_count` decide.
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
		unrepairable	: extra?.unrepairable || [],
		duplicated		: extra?.duplicated || [],
		tags_missing	: extra?.tags_missing || [],
		stray			: extra?.stray || [],
		outside_text	: extra?.outside_text || 0,
		degenerate		: is_degenerate(source_text, restored_text),
		repaired		: extra?.repaired || [],
		reordered		: extra?.reordered || [],
		residual		: extra?.residual || [],
		emphasis_lost	: count_emphasis_lost(source_text, restored_text),
		total_marks		: source_marks.length
	}

	report.refused =
		report.missing.length>0 ||
		report.added.length>0 ||
		report.unrepairable.length>0 ||
		report.duplicated.length>0 ||
		report.tags_missing.length>0 ||
		report.stray.length>0 ||
		report.outside_text>0 ||
		report.degenerate===true

	// positions or presence WE decided rather than the model: saved, and reported
	report.uncertain_count =
		report.repaired.length +
		report.reordered.length +
		report.residual.length

	return report
}//end validate_translation



/**
* MARK_REPORT_LINES
* The operator-facing account of the report, most consequential first, one line per kind.
* Used both for a refused run (under 'translation_review_needed') and for a run saved with
* positions we chose (under 'translation_saved_with_warnings').
* @param {Object} report - validate_translation() output.
* @param {Function} get_label - (key, ...args) => string|null; the tool label resolver.
* @returns {string[]}
*/
export const mark_report_lines = function(report, get_label) {

	const lines = []

	// a loop instead of a translation: every other line is moot, the text is garbage
	if (report.degenerate===true) {
		lines.push(
			get_label('translation_degenerate')
			|| 'The model repeated itself instead of translating.'
		)
	}

	// marks (and shielded tags) that are gone or that nobody could place. A token the
	// model duplicated had every copy removed, so it is counted here as missing.
	const unplaced = report.missing.length + report.unrepairable.length + report.tags_missing.length
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

	// marks that landed inside markup instead of text
	if (report.outside_text>0) {
		lines.push(
			get_label('marks_outside_text', report.outside_text)
			|| `${report.outside_text} marks ended up inside the markup instead of the text`
		)
	}

	// marks we re-inserted ourselves: present, but WE chose the position
	if (report.repaired.length>0) {
		lines.push(
			get_label('marks_repositioned', report.repaired.length, report.total_marks)
			|| `${report.repaired.length} of ${report.total_marks} marks were repositioned automatically`
		)
	}

	// pairs the translation reversed, which we put back in open→close order
	if (report.reordered.length>0) {
		lines.push(
			get_label('marks_reordered', report.reordered.length)
			|| `${report.reordered.length} linked marks were reversed by the translation and reordered`
		)
	}

	// markers the model duplicated, invented, or that map to nothing — removed
	const invalid = report.residual.length + report.duplicated.length + report.stray.length
	if (invalid>0) {
		lines.push(
			get_label('marks_removed_invalid', invalid)
			|| `${invalid} invalid markers were removed`
		)
	}

	// formatting the model dropped: never a reason on its own, listed when lines are shown
	if (report.emphasis_lost>0 && lines.length>0) {
		lines.push(
			get_label('emphasis_lost', report.emphasis_lost)
			|| `${report.emphasis_lost} text styles (bold, italic) were lost`
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
* Soft worker errors (v6 40bf5eaacf): the chosen model cannot run here — it has no model for
* the pair, needs a GPU the browser does not offer, or does not fit in memory. The worker is
* still fine; the run RESOLVES {result:false} with the worker's message, which names what to
* try instead. Nothing was saved.
* @type {string[]}
*/
const SOFT_ERROR_CODES = ['no_model', 'unsupported_lang', 'unsupported_pair', 'needs_webgpu', 'model_too_large']



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
*   Main → Worker: { options: { blocks[], sourceLangCode, targetLangCode, device, dtype, engine, model } }
*   Worker → Main: 'init' | 'on_chunk' | 'end' | 'on_block_error' | 'cancelled' | 'error'
*
* Before the worker starts, a run with no model definition (`model` null: none offered) or a
* source/target language with no locale code resolves {result:false, code:'no_model' |
* 'unsupported_lang'} (soft: nothing touched, the worker never started).
*
* Before the worker starts, the run is REFUSED (rejects, nothing touched) when a component
* is not in 'edit' mode (v6: in list/tm mode the value is truncated rendered HTML, not the
* raw marks — saving it back would destroy the record), the source is empty, or the
* source's own text contains token-shaped text (source_has_token_shaped_text).
*
* Data-model update on 'end' — ONLY for a run that passed every check:
*   Both `target_component.data.value[]` (legacy) and `target_component.data.entries[]`
*   (v7) are updated before save(). The entry `id` is preserved from the existing target
*   entry when it exists, otherwise it falls back to the source entry id.
*
* Refusals on 'end' (nothing saved, the target's own data put back, the reason named in
* the status area, the Promise REJECTS):
*   1. a block was lost (the worker SKIPS a failed block — 'on_block_error');
*   2. the result is empty (it would BLANK the target language);
*   3. a mark or tag cannot be accounted for, a mark sits outside the text, or the result
*      is a repetition loop (validate_translation → refused).
* Positions WE chose (repaired, reordered, invented tokens removed) are saved and the
* resolve says so: {result:true, msg:'OK. Translation saved with warnings', warnings:report}
* — the status area lists them (owner ruling Q2, 2026-11-22: save with warning, no
* accept/discard step).
*
* @param {Object} options
* @param {Object}        options.source_component           - Initialised component
*                                                             supplying the source text.
* @param {Object}        options.target_component           - Initialised component that
*                                                             will receive and save the
*                                                             translated text.
* @param {string}        options.source_lang                - Dédalo lang code, e.g. 'lg-eng'.
* @param {string}        options.target_lang                - Dédalo lang code, e.g. 'lg-spa'.
* @param {string}        [options.device='webgpu']          - 'webgpu' or 'wasm' (CPU).
* @param {string|null}   [options.dtype]                    - quantisation override (the q4/q8
*                                                             choice, among the model's pinned dtypes); null:
*                                                             the model's own dtype.
* @param {string}        [options.engine]                   - model name (browser_models.js);
*                                                             informative only — the worker
*                                                             runs `model`, never a name lookup.
* @param {Object|null}   [options.model]                    - the selected model's definition,
*                                                             one the installation OFFERS
*                                                             (selected_browser_options); null
*                                                             → soft refusal 'no_model'.
* @param {Array}         [options.alternatives]             - the offered models
*                                                             [{name, label, requires_webgpu}]
*                                                             a needs_webgpu / model_too_large
*                                                             refusal may suggest.
* @param {HTMLElement}   options.status_container           - Element for status/progress text.
* @param {HTMLElement|null} [options.streaming_overlay]     - Overlay element shown while
*                                                             translation is streaming.
* @param {HTMLElement|null} [options.streaming_overlay_content] - Inner element of the
*                                                             overlay; receives incremental HTML.
* @param {Array|null}    [options.json_langs]               - Pre-fetched lang-registry array.
* @param {Function}      [options.get_label]                - Tool label resolver: (key, ...args) => string
*                                                             (args fill the label's %s slots).
*                                                             Defaults to identity (key => key).
* @returns {Promise<{result: boolean, msg: string, warnings?: Object|null, code?: string}>}
*   Resolves {result:true} only when the save ANSWERED that the value is stored
*   (save_landed); `warnings` is the validate_translation report when positions were
*   chosen by us, else null. Resolves {result:false} on a cancellation or a soft worker
*   error (`code`). Rejects on every refusal above, a fatal worker error, an exception in
*   the message handler and a save that did not land. Rejection (not a resolve carrying
*   result:false) is load-bearing: a caller that counts resolves as done must never count
*   a refused run.
*/
export const translate_component_browser = async function(options) {

	// options
		const source_component			= options.source_component
		const target_component			= options.target_component
		const source_lang				= options.source_lang
		const target_lang				= options.target_lang
		const device					= options.device || 'webgpu'
		const dtype						= options.dtype || null
		const engine					= options.engine || null
		const model						= options.model || null
		const alternatives				= Array.isArray(options.alternatives) ? options.alternatives : []
		const status_container			= options.status_container
		const streaming_overlay			= options.streaming_overlay || null
		const streaming_overlay_content	= options.streaming_overlay_content || null
		const get_label					= typeof options.get_label==='function'
			? options.get_label
			: (key) => key // identity fallback: show raw key when no label map is provided

	// refuse_before_run. Nothing has been touched yet: name the reason and reject.
		const refuse_before_run = function(lines) {
			if (status_container) {
				status_container.classList.remove('hide')
				status_container.classList.remove('loading_status')
				status_container.replaceChildren(status_lines_node('error', lines))
			}
			return Promise.reject(new Error(lines.join(' ')))
		}

	// mode guard (v6 40bf5eaacf). Only in 'edit' mode does component_text_area expose the
	// raw bracket marks this pipeline reads and writes; in list/tm mode data.value is
	// rendered HTML truncated for display — the marks would not be found, and saving that
	// string back would destroy the record.
		for (const component of [source_component, target_component]) {
			const mode = component?.mode || component?.context?.mode
			if (mode && mode!=='edit') {
				return refuse_before_run([
					`Translation requires components in 'edit' mode; got '${mode}'.`
				])
			}
		}

	// source text
		const { source_text, first_entry } = get_source_text(source_component)
		if (!source_text) {
			return Promise.reject('Empty source text')
		}

	// refuse_soft_before_run. The choice cannot run here (no model offered, a language the
	// model cannot be told): nothing touched, nothing saved — say so and resolve
	// {result:false, code}, like a soft worker error (the worker is never started).
		const refuse_soft_before_run = function(code, msg) {
			if (status_container) {
				status_container.classList.remove('hide')
				status_container.classList.remove('loading_status')
				status_container.replaceChildren(status_lines_node('warning', [
					msg,
					get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.'
				]))
			}
			return Promise.resolve({ result : false, msg : msg, code : code })
		}

	// the model: the definition of one the installation OFFERS (selected_browser_options).
	// No fallback — the worker would have to guess, and could guess a model not offered.
		if (!model || typeof model.name!=='string' || !model.name) {
			return refuse_soft_before_run(
				'no_model',
				get_label('translation_no_model')
					|| 'Translation not started: this installation offers no browser translation model'
			)
		}

	// language mapping. A language without a locale is REFUSED (no 'en' fallback: it would be
	// translated as English and saved as the target language's text).
		const json_langs = options.json_langs || await get_json_langs() || []

		const source_lang_code = dedalo_to_locale(source_lang, json_langs)
		const target_lang_code = dedalo_to_locale(target_lang, json_langs)
		for (const [dedalo_lang, code] of [[source_lang, source_lang_code], [target_lang, target_lang_code]]) {
			if (!code) {
				return refuse_soft_before_run(
					'unsupported_lang',
					get_label('translation_lang_unmapped', dedalo_lang)
						|| `Translation not started: the language ${dedalo_lang} has no locale code a translation model understands`
				)
			}
		}

	// clean hard coded spaces
	// &nbsp; entities confuse the markdown converter and appear verbatim in the
	// model input; replace them with regular spaces before further processing.
		const clean_source_text = source_text.replace(/&nbsp;/g, ' ')

	// the source's own text must not look like a token (it would be read back as one)
		if (source_has_token_shaped_text(clean_source_text)) {
			return refuse_before_run([
				get_label('translation_token_collision')
					|| 'Translation refused: the text contains [[[n]]]-like sequences that the translation markers would be confused with',
				get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.'
			])
		}

	// shield the Dédalo marks and every tag without a Markdown form behind [[[n]]] tokens,
	// and convert the rest to Markdown (see source_to_markdown)
		const { md, placeholders, descriptors, block_tokens } = source_to_markdown(clean_source_text)
		if (has_token_shaped_text(md)) {
			// two tokens (or a token and a bracket of the text) that touch can form one
			return refuse_before_run([
				get_label('translation_token_collision')
					|| 'Translation refused: the text contains [[[n]]]-like sequences that the translation markers would be confused with',
				get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.'
			])
		}

	// segment, then one block per segment (balanced, edges hoisted, tokens renumbered)
	// SEGMENT_MAX_CHARS is small on purpose (v6 55c816b41c): TranslateGemma is a
	// sentence-level model and 1000-character blocks were the dominant cause of its
	// repetition loops; at this size nearly every mark sits at a segment edge, where it is
	// hoisted out of the model's way. The cost is more model calls per record.
		const segments	= segment_markdown(md, SEGMENT_MAX_CHARS)
		const blocks	= build_blocks(segments, descriptors)

	// mark html for markdown_to_html: a shielded block-level element is not wrapped in <p>
		const to_html = (markdown) => markdown_to_html(markdown, { block_tokens })

	// reusable worker (model cached across calls)
		const translate_worker = get_browser_worker()

	// a cancel requested from now on wins over an 'end' already on its way
		cancel_requested = false

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

		// failed_blocks. Every 'on_block_error' the worker posts for THIS run — the
		// worker SKIPS a failed block, so its accumulated text is short by exactly those
		// paragraphs. 'end' also carries the worker's own list (data.failed_blocks); both
		// are merged by block number and 'end' refuses while either is non-empty.
			const failed_blocks = []
			const add_failed_block = function(item) {
				if (!failed_blocks.some(failed => failed.block===item.block)) {
					failed_blocks.push({ block : item.block, total : item.total, message : item.message })
				}
			}

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

		const hide_overlay = function() {
			if (streaming_overlay) {
				streaming_overlay.classList.add('hide')
			}
		}

		/**
		* REFUSE_RUN
		* Abandon the translation WITHOUT WRITING ANYTHING: put the target
		* component's own data back, re-render it from that data, name what went
		* wrong in the status area and reject.
		* @param {Array<string>} lines - operator-facing message, one line each.
		* @return void
		*/
		const refuse_run = function(lines) {

			hide_overlay()

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

		/**
		* PREVIEW_HTML
		* The accumulated translation with its marks and tags put back — for display only;
		* the decision on them is taken at 'end'.
		* @param {string} accumulated - document-wide-token Markdown
		* @return {string}
		*/
		const preview_html = function(accumulated) {
			return restore_placeholders(to_html(accumulated), placeholders).text
		}

		/**
		* ON_END
		* The worker has stopped. It posts 'end' whether or not every block translated, so
		* this decides between SAVING a result that passed every check and REFUSING one
		* that did not. Nothing above the refusals may report success or touch the stored
		* value.
		* @param {Object} data - the 'end' payload
		* @return void
		*/
		const on_end = function(data) {

			// the operator stopped the run: an 'end' already on its way does not save
			if (cancel_requested) {
				on_cancelled()
				return
			}

			for (const item of (data.failed_blocks || [])) {
				add_failed_block(item)
			}

			// REFUSAL 1 — blocks were lost.
			// The accumulated text is missing those paragraphs. Saving it would
			// overwrite the target language's existing text — which may be a
			// human translation — with a shorter machine one. Name the lost blocks
			// (capped at MAX_LISTED) and state that the existing text is intact.
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
				return
			}

			// Prefer accumulated_text (streaming model); fall back to stringifying
			// the raw data payload for non-streaming worker implementations.
			const translated_md = data.accumulated_text ?? String(data)

			// shielded tag pairs the translation reversed go back in order (tokens), then
			// markdown -> HTML (every character the model wrote escaped), then the marks and
			// tags are restored — every token exactly once, or the run is refused
			const ordered_tokens	= reorder_inverted_tokens(translated_md, descriptors)
			const restored			= restore_placeholders(to_html(ordered_tokens.text), placeholders)

			// translation can reverse a paired mark (close before open) — put it
			// back in order before validating and saving, and report it
			const ordered		= reorder_inverted_pairs(restored.text)
			const restored_text	= ordered.text

			// REFUSAL 2 — the run produced no text at all.
			// The source was checked non-empty before the worker was started, so an
			// empty result is a failure however the worker reached it. Saving it would
			// BLANK the target language and answer ok.
			if (!restored_text || restored_text.trim()==='') {
				refuse_run([
					get_label('translation_empty_result') || 'Translation refused: the model returned no text',
					get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.',
					get_label('translation_retry') || 'Run the translation again to retry.'
				])
				return
			}

			// REFUSAL 3 — a mark or tag cannot be accounted for, a mark sits outside the
			// text, or the result is a loop. The marks are counted against the source
			// directly; repair_stats alone is not trusted.
			const shield_tokens = new Set(descriptors.filter(item => item.shield).map(item => item.token))
			const repair_stats	= data.repair_stats || {}
			const outside_count = (html) =>
				extract_dedalo_marks(html).length - marks_in_text_nodes(html, extract_dedalo_marks).length
			const report = validate_translation(clean_source_text, restored_text, {
				repaired		: repair_stats.repaired || [],
				unrepairable	: repair_stats.unrepairable || [],
				duplicated		: [...(repair_stats.duplicated || []), ...restored.duplicated],
				residual		: repair_stats.residual || [],
				reordered		: [...ordered.reordered, ...ordered_tokens.reordered],
				tags_missing	: restored.missing.filter(token => shield_tokens.has(token)),
				stray			: restored.residual,
				outside_text	: Math.max(0, outside_count(restored_text) - outside_count(clean_source_text))
			})
			const mark_lines = mark_report_lines(report, get_label)
			if (report.refused) {
				refuse_run([
					get_label('translation_review_needed') || 'Translation needs review before saving',
					...mark_lines,
					get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.',
					get_label('translation_retry') || 'Run the translation again to retry.'
				])
				return
			}

			// the result passed every check.
			// (!) NOT 'completed' yet: that is only true once the save has
			// answered that the value is stored (see save_landed below).
			hide_overlay()

			// shared cross-language id from source entry
			const source_id = (typeof first_entry==='object' && first_entry!==null)
				? (first_entry.id ?? null)
				: null

			// use target's own id if it exists, else fall back to source id
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

			const save_item = {
				action	: 'update',
				id		: entry_id,
				value	: entry
			}
			// THE OUTCOME IS WHAT THE SAVE ANSWERED (T1-P01). component_common's
			// save() never rejects: a failed save RESOLVES its failure envelope and
			// every pre-wire refusal resolves `false`. The failed edit is NOT restored
			// here: save() already registered it as unsaved data.
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
				// positions WE chose are saved but never reported as a clean completion:
				// the operator checks them
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
					? {result: true, msg: 'OK. Translation saved with warnings', warnings: report}
					: {result: true, msg: 'OK. Translation completed', warnings: null})
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
		}//end on_end

		/**
		* ON_CANCELLED
		* The operator stopped the run. Nothing was saved, but 'on_chunk' left a fragment
		* in the live instance data — put the target's own value back.
		* @return void
		*/
		const on_cancelled = function() {
			hide_overlay()
			restore_target_data()
			if (status_container) {
				status_container.classList.remove('loading_status')
				status_container.textContent = get_label('translation_cancelled') || 'Translation cancelled'
			}
			resolve({result: false, msg: 'Translation cancelled'})
		}//end on_cancelled

		/**
		* HANDLE_MESSAGE
		* One worker message.
		* @param {string} status
		* @param {Object} data
		* @return void
		*/
		const handle_message = function(status, data) {

			switch (status) {

				// model is being downloaded and initialised; show progress percentage
				case 'init': {

					const progress		= data.progress
					const status_text	= data.status
					const device_text	= data.device

					// 'setting_up' label shown after model is loaded (GPU path);
					// 'procesing' (sic) is reused on the WASM path during model compile.
					const process_label = device_text==='webgpu' ? 'setting_up' : 'procesing'

					// 'ready'            — model is compiled, about to start translating
					// 'fallback_to_wasm' — WebGPU failed for a small model; the worker
					//                      fell back to WASM CPU
					// (other)            — model is still downloading/compiling
					const label = status_text==='ready'
						? get_label( process_label )
						: (status_text==='fallback_to_wasm')
							? (get_label('gpu_unavailable') || 'GPU unavailable, switching to CPU')
							: get_label( 'initializing' )

					// progress is a 0–100 number during download; absent once loading is done.
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
						status_container.innerText = `${procesing_label} (${data.remaining} ${remaining_label})`
					}

					// the accumulated translation, marks restored, into the component's live
					// data (put back by restore_target_data on every run that does not save)
					const html_accumulated = preview_html(data.accumulated_text)
					if (!target_component.data.value) {
						target_component.data.value = []
					}
					target_component.data.value[0] = html_accumulated
					if (streaming_overlay_content) {
						// Machine translation of record text: rendered by the TARGET
						// component's server class (text_area 'html' passes, anything
						// else is escaped) — the ONE escaper, render_escape_tripwire.
						streaming_overlay_content.innerHTML = render_value(html_accumulated, target_component.context?.render_class)
					}
					break;
				}

				case 'end': {
					on_end(data)
					break;
				}

				// per-block failure. Non-fatal FOR THE WORKER (it skips the block and
				// translates the rest) but fatal for the RESULT. Record it — 'end' refuses
				// while failed_blocks is non-empty — and keep the run going so the operator
				// sees the whole account at once.
				case 'on_block_error': {
					add_failed_block(data)
					console.warn(`Block ${data.block}/${data.total} failed: ${data.message}`)
					if (status_container) {
						const block_warn_label = get_label('block_error') || 'Block error'
						// the RUNNING COUNT, not only the last failure
						status_container.replaceChildren(status_lines_node('warning', [
							`${block_warn_label}: ${data.block}/${data.total} (${failed_blocks.length})`
						]))
					}
					if (data.accumulated_text && streaming_overlay_content) {
						streaming_overlay_content.innerHTML = render_value(preview_html(data.accumulated_text), target_component.context?.render_class)
					}
					break;
				}

				case 'cancelled': {
					on_cancelled()
					break;
				}

				case 'error': {

					// SOFT: the chosen model cannot run here (v6). The worker is fine; say
					// what to try instead and resolve {result:false} — nothing was saved.
					if (SOFT_ERROR_CODES.includes(data.code)) {
						hide_overlay()
						restore_target_data()
						if (status_container) {
							status_container.classList.remove('loading_status')
							status_container.replaceChildren(status_lines_node('warning', [String(data.message || data.code)]))
						}
						resolve({result: false, msg: String(data.message || data.code), code: data.code})
						break;
					}

					// fatal worker error; dispose worker and reject. Whatever had already
					// been streamed into the target component is a fragment of a run that
					// died — put the target's own value back.
					dispose_browser_worker()
					hide_overlay()
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
		}//end handle_message

		// handle messages sent back from the worker.
		// An exception here (a malformed message, a converter bug) must not leave the
		// run hanging with the streamed fragment in the live data: the worker is told to
		// stop, this run stops listening, the target's own value is put back, the
		// overlay comes down and the Promise REJECTS (A1-02 review).
		translate_worker.onmessage = function(e) {
			try {
				handle_message(e.data?.status, e.data?.data)
			} catch (handler_error) {
				console.error('Translation message handler failed:', handler_error)
				translate_worker.onmessage = null
				translate_worker.postMessage({ cancel : true })
				hide_overlay()
				restore_target_data()
				if (status_container) {
					status_container.classList.remove('loading_status')
					status_container.replaceChildren(status_lines_node('error', [
						String(handler_error?.message || handler_error),
						get_label('nothing_saved') || 'Nothing was saved. The existing text in the target language is unchanged.'
					]))
				}
				reject(handler_error instanceof Error ? handler_error : new Error(String(handler_error)))
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
			hide_overlay()
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
				device			: device,
				dtype			: dtype,
				engine			: engine,
				model			: model,
				alternatives	: alternatives
			}
		})
	})
}//end translate_component_browser



// @license-end
