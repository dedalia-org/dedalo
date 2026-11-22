// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * BLOCK_RUNNER
 * The worker side of the browser translation, everything except the model itself.
 *
 * tools/tool_lang/translators/browser_transformer/browser_transformer.js loads the model
 * and hands this module a `translate(text, overrides, label)` function; what happens to
 * the blocks — the order, the repetition escalation, the repair of the markers the model
 * lost, the re-attachment of the hoisted ones, the progress messages — lives here, where
 * it can be exercised with a stand-in translate function (the model needs a multi-GB
 * download and a GPU, so the worker file itself is never loaded by a gate).
 *
 * Like placeholders.js, this module must not depend on the Dédalo runtime: it runs inside
 * the Web Worker. It imports placeholders.js and markdown_utils.js (whose emphasis helpers
 * are DOM-free; html_to_markdown is only ever called on the main thread).
 *
 * A block is (built by browser_translation.js build_blocks):
 *   {
 *     text         : '…[[[1]]]término[[[2]]]…',   // Markdown, tokens local to this block
 *     placeholders : [{ token, kind:'open'|'close'|'atom', pair }],
 *     restore_map  : { '[[[1]]]' : '[[[7]]]' },    // local token → document-wide token
 *     prefix       : '[[[6]]] ',                   // hoisted edge tokens, DOCUMENT-WIDE
 *     suffix       : ' [[[9]]]',
 *     sep          : '\n'                          // what preceded the segment in the source
 *   }
 *
 * THE MODEL CANNOT BE INSTRUCTED (v6 92da452aa1). TranslateGemma translates whatever is in
 * its text field — an instruction or a "you dropped [[[3]]], put it back" correction comes
 * back TRANSLATED, into the record. So there is no corrective retry here (the TS worker
 * had three, built on exactly such a prompt; removed with this port). Markers survive by
 * mechanisms that need no cooperation from the model:
 *   - hoisting: edge markers never reach the model (browser_translation.js
 *     hoist_edge_placeholders) and are re-attached here verbatim;
 *   - copying: interior markers ride through as [[[n]]], which translation models generally
 *     copy as unknown tokens;
 *   - repair_placeholders(): places whatever was dropped, and every token it placed is
 *     REPORTED.
 * The only retries are for a LOOP (detect_repetition): a stiffer repetition penalty, then
 * sampling — greedy decoding is itself what falls into the loop.
 *
 * Messages posted (the worker relays them to the main thread unchanged):
 *   { status: 'on_chunk',       data: { accumulated_text, remaining, repair_stats, failed_blocks } }
 *   { status: 'on_block_error', data: { message, block, total, accumulated_text, remaining } }
 *   { status: 'cancelled',      data: { accumulated_text, remaining, repair_stats, failed_blocks } }
 *   { status: 'end',            data: { accumulated_text, remaining, repair_stats, failed_blocks } }
 *
 * repair_stats = what WE did instead of the model (document-wide tokens unless stated):
 *   repaired     — tokens the model dropped that repair_placeholders placed
 *   unrepairable — tokens nobody could place (appended at the block end)
 *   duplicated   — tokens the model emitted more than once; every copy removed (which copy
 *                  is right is unknowable, so none is kept)
 *   residual     — tokens the model invented (not in the block), removed; LOCAL numbers
 *                  with no document-wide meaning, so only their count matters
 * The main thread reports them, and refuses a run with an unrepairable or duplicated token.
 *
 * TS differences from the v6 worker: a block that throws is SKIPPED and reported (v6 kept
 * its source text) — the main thread refuses a run that lost a block; an invented token is
 * removed here per block (forwarded, its local number could be read as a REAL mark of
 * another block); a duplicated token is never resolved by keeping one copy; the hoisted
 * prefix/suffix are attached AFTER the local→global mapping (v6 attached them before, so a
 * hoisted global [[[2]]] was remapped whenever the block also had a local [[[2]]]); a block
 * with nothing but tokens and whitespace never reaches the model; a cancel that arrives
 * during the last block ends the run as 'cancelled', never 'end'.
 *
 * Exports:
 *   REPETITION_PENALTY_FIRST, REPETITION_ESCALATIONS, MAX_LENGTH_RATIO
 *   strip_fences       — unwrap the fences, quotes or preamble a model put around its answer
 *   token_problems     — which of a block's tokens are not present exactly once
 *   detect_repetition  — has the model looped instead of translating
 *   to_global_tokens   — local → document-wide tokens
 *   process_block      — translate one block, return it with every marker accounted for
 *   run_blocks         — the block loop and its messages
 *   run_precondition   — the soft refusal a run gets before any model is touched (no model,
 *                        no language code), or null
 *   smaller_model_advice — the 'try a smaller model' sentence, from the OFFERED catalogue
 *   needs_webgpu_message, too_large_message — the two refusals that carry that advice
 *   collapse_model_breaks — the model's line breaks in a segment that had none → one space
 */

// imports
import { conform_emphasis, restore_wrapping_emphasis } from './markdown_utils.js';
import {
	extract_placeholders,
	normalize_placeholders,
	placeholder_re,
	repair_placeholders,
} from './placeholders.js';

/**
 * Repetition penalty of the FIRST attempt (v6 55c816b41c). A penalty suppresses tokens
 * already emitted — ruinous for markers built of repeated brackets, which is why it had been
 * off (1.0), and turning it off is what let greedy decoding loop. It is back, mildly, because
 * hoisting keeps most markers out of the model input.
 * @type {number}
 */
export const REPETITION_PENALTY_FIRST = 1.1;

/**
 * What a looping block is retried with, in order (v6): a stiffer penalty (cheap, still
 * deterministic), then sampling at a low temperature — a deterministic decoder walks
 * straight back into the loop.
 * @type {Array<{repetition_penalty:number, do_sample?:boolean, temperature?:number, top_p?:number}>}
 */
export const REPETITION_ESCALATIONS = [
	{ repetition_penalty: 1.2 },
	{ repetition_penalty: 1.2, do_sample: true, temperature: 0.3, top_p: 0.9 },
];

/**
 * Longest repeating cycle to look for, in words: a greedy-decode loop is almost always a
 * short phrase. (v6)
 * @type {number}
 */
const MAX_CYCLE_WORDS = 6;

/**
 * How many times a multi-word cycle must repeat back-to-back to count as a loop. (v6)
 * @type {number}
 */
const MIN_CYCLE_REPEATS = 3;

/**
 * A single word needs a higher bar: 'no, no, no' is ordinary speech. (v6)
 * @type {number}
 */
const MIN_UNIGRAM_REPEATS = 5;

/**
 * A translation is roughly as long as its source; past this multiple it is not a
 * translation any more. (v6; the main thread applies the same ratio to the whole value —
 * browser_translation.js is_degenerate.)
 * @type {number}
 */
export const MAX_LENGTH_RATIO = 2.5;

/**
 * RUN_PRECONDITION
 * What the worker must refuse (SOFT: the worker stays usable, nothing is touched) before it
 * loads anything (A1-02 re-review):
 *   - no model DEFINITION. The main thread sends the definition the operator chose from the
 *     catalogue the installation OFFERS (register.json → browser_transformer.models through
 *     offered_models). There is no fallback: a name looked up in the shipped catalogue, or
 *     its first entry, could run a model the installation does not offer (NLLB, CC-BY-NC).
 *   - no source or target language code. A language without a locale mapping must never be
 *     translated as 'en' → 'es' (it would be saved as the other language's text).
 * @param {Object} options - the worker's options message
 * @returns {{code:string, message:string}|null} null when the run may proceed
 */
export const run_precondition = (options) => {
	const model = options?.model;
	if (!model || typeof model !== 'object' || typeof model.name !== 'string' || !model.name) {
		return {
			code: 'no_model',
			message: 'No translation model was chosen: this installation offers none for the browser engine.',
		};
	}
	for (const [side, code] of [
		['source', options.sourceLangCode],
		['target', options.targetLangCode],
	]) {
		if (typeof code !== 'string' || !code) {
			return {
				code: 'unsupported_lang',
				message: `The ${side} language has no language code the '${model.name}' model understands.`,
			};
		}
	}
	return null;
}; //end run_precondition

/**
 * SMALLER_MODEL_ADVICE
 * The 'try a smaller model' sentence of a needs_webgpu / model_too_large refusal, built from
 * the models the installation OFFERS (options.alternatives: [{name, requires_webgpu}]) — never
 * from a hard-coded list, which named NLLB (listed, not offered). A model that itself needs
 * WebGPU is no smaller alternative; the current one is not an alternative. Nothing to offer
 * → '' (the refusal still says why).
 * @param {Array<{name:string, label?:string, requires_webgpu?:boolean}>|undefined} alternatives
 * @param {string} current_name
 * @returns {string} ' Try a smaller model: a, b.' or ''
 */
export const smaller_model_advice = (alternatives, current_name) => {
	const names = (Array.isArray(alternatives) ? alternatives : [])
		.filter((item) => item && typeof item.name === 'string' && item.name !== current_name && !item.requires_webgpu)
		.map((item) => (typeof item.label === 'string' && item.label ? item.label : item.name));
	return names.length > 0 ? ` Try a smaller model: ${names.join(', ')}.` : '';
}; //end smaller_model_advice

/**
 * NEEDS_WEBGPU_MESSAGE
 * The needs_webgpu refusal: with WebGPU present, the CPU option is what stands in the way;
 * without it, the model cannot run here and the offered smaller models are named.
 * @param {string} engine_name
 * @param {boolean} webgpu_available
 * @param {Array|undefined} alternatives - see smaller_model_advice
 * @returns {string}
 */
export const needs_webgpu_message = (engine_name, webgpu_available, alternatives) =>
	`The '${engine_name}' model needs WebGPU (GPU). ` +
	(webgpu_available
		? 'Turn off the "more compatible / CPU" option to use it.'
		: `This browser has no WebGPU available, so this model cannot run here.${smaller_model_advice(alternatives, engine_name)}`); //end needs_webgpu_message

/**
 * TOO_LARGE_MESSAGE
 * The model_too_large refusal, naming the offered smaller models.
 * @param {string} engine_name
 * @param {Array|undefined} alternatives - see smaller_model_advice
 * @returns {string}
 */
export const too_large_message = (engine_name, alternatives) =>
	`The '${engine_name}' model is too large to load on this device.${smaller_model_advice(alternatives, engine_name)}`; //end too_large_message

/**
 * STRIP_FENCES
 * Unwrap the answer from whatever a model wrapped it in: <<< >>> fences, 《…》 / 「…」
 * quotes, a 'Here is the translation:' preamble. (v6 40bf5eaacf)
 * @param {string} text - Raw model response.
 * @returns {string}
 */
export const strip_fences = (text) => {
	if (!text) {
		return '';
	}

	const fenced = text.match(/<<<\s*([\s\S]*?)\s*>>>/);
	if (fenced) {
		return fenced[1].trim();
	}

	const quoted = text.trim().match(/^[《「『]\s*([\s\S]*?)\s*[》」』]$/);
	if (quoted) {
		return quoted[1].trim();
	}

	return text
		.trim()
		.replace(/^(?:here (?:is|'s)[^\n:]{0,40}:|translation:|traducci[oó]n:)\s*/i, '')
		.replace(/^<<<\s*/, '')
		.replace(/\s*>>>$/, '')
		.replace(/^[《「『]\s*/, '')
		.replace(/\s*[》」』]$/, '')
		.trim();
}; //end strip_fences

/**
 * TOKEN_PROBLEMS
 * Which of a block's tokens the output does not carry EXACTLY once.
 * @param {string[]} block_tokens - The block's tokens.
 * @param {string}   output_text  - Model output, normalised, invented tokens removed.
 * @returns {{missing:string[], duplicated:string[], count:number}}
 */
export const token_problems = (block_tokens, output_text) => {
	const counts = new Map();
	for (const token of extract_placeholders(output_text)) {
		counts.set(token, (counts.get(token) || 0) + 1);
	}

	const missing = [];
	const duplicated = [];
	for (const token of block_tokens) {
		const count = counts.get(token) || 0;
		if (count === 0) {
			missing.push(token);
		} else if (count > 1) {
			duplicated.push(token);
		}
	}

	return { missing, duplicated, count: missing.length + duplicated.length };
}; //end token_problems

/**
 * DETECT_REPETITION
 * Detect that greedy decoding fell into a loop. (v6 55c816b41c, verbatim logic.)
 *
 * Real degeneration is usually an n-gram CYCLE — 'सामान्य भन्दा सामान्य भन्दा …' — where no
 * two adjacent words are equal, so this scans for a repeating cycle of any length up to
 * MAX_CYCLE_WORDS (which subsumes the unigram case), over the whole text.
 * @param {string} text          - Translated text to check.
 * @param {string} [source_text] - The text it was translated FROM; a wildly longer output
 *   is degenerate whatever the n-gram scan says.
 * @returns {boolean}
 */
export const detect_repetition = (text, source_text) => {
	if (!text || text.length < 50) {
		return false;
	}

	if (source_text && source_text.length > 0 && text.length > source_text.length * MAX_LENGTH_RATIO) {
		return true;
	}

	const words = text.trim().split(/\s+/);

	for (let size = 1; size <= MAX_CYCLE_WORDS; size++) {
		const min_repeats = size === 1 ? MIN_UNIGRAM_REPEATS : MIN_CYCLE_REPEATS;
		if (words.length < size * min_repeats) {
			break;
		}

		for (let start = 0; start + size * min_repeats <= words.length; start++) {
			let repeats = 1;
			let next = start + size;

			while (next + size <= words.length) {
				let same = true;
				for (let i = 0; i < size; i++) {
					if (words[next + i] !== words[start + i]) {
						same = false;
						break;
					}
				}
				if (!same) {
					break;
				}
				repeats++;
				next += size;
			}

			if (repeats >= min_repeats) {
				return true;
			}
		}
	}

	return false;
}; //end detect_repetition

/**
 * TO_GLOBAL_TOKENS
 * Map a block's local tokens back to the document-wide tokens the main thread uses.
 *
 * process_block has already removed every token the block does not own, so every token
 * here has an entry. One without an entry is still never forwarded under its local number
 * — that number may be a real document-wide mark of another block — it is dropped.
 * @param {string} text
 * @param {Object} restore_map - local token → global token
 * @returns {string}
 */
export const to_global_tokens = (text, restore_map) => {
	if (!text) {
		return text;
	}

	return text.replace(placeholder_re(), (match) => restore_map?.[match] || '');
}; //end to_global_tokens

/**
 * CLEAN_OUTPUT
 * Everything the model hands back goes through here: unwrap it (strip_fences), normalise
 * the markers it merely mangled ([[5]], [[[ 5 ]]], localised digits), remove the ones it
 * invented, delete emphasis it invented and restore the emphasis it dropped from a
 * wholly-emphasised segment (v6).
 *
 * An invented token ([[[9]]] in a block of three) maps to no mark of this block; left in,
 * it would reach the main thread as a document-wide number — very possibly a REAL mark of
 * another block. It carries no mark, so removing it loses nothing; it is counted.
 *
 * A line break the model wrote into a segment that had NONE is collapsed to a space
 * (A1-02 re-review, collapse_model_breaks): '\n\n' is a paragraph and '\n' a <br> to
 * markdown_to_html, so inside a shielded block ('<li>uno\n\ndos</li>') it built malformed
 * HTML — a <p> across the </li>, a <br> between two </td><td>.
 * @param {*} raw - Model output.
 * @param {string} source - The block text sent to the model.
 * @param {Set<string>} known - The block's own tokens.
 * @returns {{text:string, invented:string[]}}
 */
const clean_output = (raw, source, known) => {
	const invented = [];
	const normalised = normalize_placeholders(strip_fences(String(raw ?? ''))).replace(placeholder_re(), (token) => {
		if (known.has(token)) {
			return token;
		}
		invented.push(token);
		return '';
	});

	const text = restore_wrapping_emphasis(source, conform_emphasis(source, collapse_model_breaks(source, normalised)));

	return { text, invented };
}; //end clean_output

/**
 * COLLAPSE_MODEL_BREAKS
 * The model's line breaks, when the segment it translated had none: every run of them (with
 * the spaces around it) becomes ONE space, and the ends are trimmed where the source had no
 * whitespace. A segment that carries a '\n' keeps the model's breaks (segment_markdown cuts
 * at every break, so none does today).
 * @param {string} source - The block text sent to the model.
 * @param {string} output - The model's answer.
 * @returns {string}
 */
export const collapse_model_breaks = (source, output) => {
	if (!output || source.includes('\n') || !/[\r\n]/.test(output)) {
		return output;
	}
	let text = output.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ');
	if (!/^\s/.test(source)) {
		text = text.replace(/^ +/, '');
	}
	if (!/\s$/.test(source)) {
		text = text.replace(/ +$/, '');
	}
	return text;
}; //end collapse_model_breaks

/**
 * PROCESS_BLOCK
 * Translate one block and account for every marker it carried.
 *
 *   1. Translate the segment — nothing but the segment goes to the model. A block that is
 *      nothing but tokens and whitespace is returned as it is, without a model call.
 *   2. If the output looped, retry with each REPETITION_ESCALATIONS step in turn; a block
 *      still looping THROWS (a loop must never be written to the record).
 *   3. Whatever markers the model dropped are placed by repair_placeholders() and reported.
 *   4. A marker the model wrote more than once is removed — every copy — and reported: the
 *      main thread refuses the run.
 *
 * @param {Function} translate - (text, overrides, label) => Promise<string>; overrides =
 *   { repetition_penalty, do_sample?, temperature?, top_p? }
 * @param {Object} block - { text, placeholders, restore_map, prefix, suffix, sep }
 * @param {Object} [options]
 * @param {string} [options.label='Block'] - Human label for messages, e.g. 'Block 2/5'
 * @param {Function} [options.is_cancelled] - () => boolean; stops the escalation early
 * @returns {Promise<{text:string, repaired:string[], unrepairable:string[], duplicated:string[], residual:string[]}>}
 *   text in LOCAL tokens, WITHOUT the hoisted prefix/suffix (run_blocks attaches them).
 */
export const process_block = async (translate, block, options = {}) => {
	const label = options.label || 'Block';
	const is_cancelled = typeof options.is_cancelled === 'function' ? options.is_cancelled : () => false;

	const block_tokens = [...new Set(extract_placeholders(block.text))];
	const known = new Set(block_tokens);

	// 1. nothing to translate: no model call (an empty prompt only invites invention)
	if (block.text.replace(placeholder_re(), '').trim() === '') {
		return { text: block.text, repaired: [], unrepairable: [], duplicated: [], residual: [] };
	}

	let output = clean_output(
		await translate(block.text, { repetition_penalty: REPETITION_PENALTY_FIRST }, label),
		block.text,
		known,
	);

	// 2. repetition degeneration
	if (detect_repetition(output.text, block.text)) {
		for (const overrides of REPETITION_ESCALATIONS) {
			if (is_cancelled()) {
				break;
			}
			const how = overrides.do_sample ? 'sampling' : `penalty ${overrides.repetition_penalty}`;
			output = clean_output(
				await translate(block.text, overrides, `${label} (repetition retry, ${how})`),
				block.text,
				known,
			);
			if (!detect_repetition(output.text, block.text)) {
				break;
			}
		}
		if (detect_repetition(output.text, block.text)) {
			throw new Error(`${label}: the model looped and could not be recovered (repetition degeneration)`);
		}
	}

	// 3. place whatever the model would not, and say so. Duplicated tokens are present,
	// so repair_placeholders leaves them alone
	const repaired = repair_placeholders(block.text, output.text, block.placeholders);

	// 4. a token present more than once: remove every copy (the main thread refuses)
	let text = repaired.text;
	const duplicated = token_problems(block_tokens, text).duplicated;
	for (const token of duplicated) {
		text = text.split(token).join('');
	}

	return {
		text,
		repaired: repaired.repaired,
		unrepairable: repaired.unrepairable,
		duplicated,
		residual: output.invented,
	};
}; //end process_block

/**
 * RUN_BLOCKS
 * Translate every block in order, posting progress as each one finishes.
 *
 * Blocks are processed one by one (not batched) so partial results stream as soon as a block
 * is done. Each translated block is mapped to document-wide tokens, its hoisted prefix and
 * suffix re-attached, and it is joined to the previous ones with its OWN `sep` — the literal
 * text that preceded it in the source (v6: a hardcoded '\n\n' turned one <p> with four <br>
 * into twenty-five <p>).
 *
 * A block whose translation throws is SKIPPED — it is not in accumulated_text — recorded in
 * failed_blocks and reported with 'on_block_error'; the main thread refuses to save a run
 * that lost a block.
 *
 * Cancellation is checked before every block AND once more before 'end': a cancel that
 * arrives while the LAST block is translating must still end the run as 'cancelled' — an
 * 'end' would make the main thread save a run the operator stopped.
 *
 * @param {Object} options
 * @param {Array}    options.blocks       - see the header
 * @param {Function} options.translate    - (text, overrides, label) => Promise<string>
 * @param {Function} options.post         - (message) => void; the worker passes self.postMessage
 * @param {Function} [options.is_cancelled] - () => boolean
 * @returns {Promise<Object>} The final result object (the 'end' or 'cancelled' payload).
 */
export const run_blocks = async (options) => {
	const blocks = options.blocks;
	const translate = options.translate;
	const post = options.post;
	const is_cancelled = typeof options.is_cancelled === 'function' ? options.is_cancelled : () => false;

	const total_blocks = blocks.length;

	// translated blocks by index (null: failed), joined with each block's sep
	const parts = [];

	const repair_stats = {
		repaired: [],
		unrepairable: [],
		duplicated: [],
		residual: [],
	};
	const failed_blocks = [];

	const result = {
		accumulated_text: '',
		remaining: total_blocks,
		repair_stats,
		failed_blocks,
	};

	const join_parts = () =>
		parts
			.map((part, k) => (part === null ? '' : (blocks[k].sep || '') + part))
			.join('')
			.replace(/^[ \t\r\n]+/, '');

	for (let i = 0; i < total_blocks; i++) {
		if (is_cancelled()) {
			post({ status: 'cancelled', data: result });
			return result;
		}

		const block = blocks[i];
		const label = `Block ${i + 1}/${total_blocks}`;

		try {
			const outcome = await process_block(translate, block, { label, is_cancelled });

			// hoisted tokens are document-wide already: attached AFTER the mapping
			parts.push(
				(block.prefix || '') + to_global_tokens(outcome.text, block.restore_map) + (block.suffix || ''),
			);

			const to_global = (token) => block.restore_map?.[token] || token;
			repair_stats.repaired.push(...outcome.repaired.map(to_global));
			repair_stats.unrepairable.push(...outcome.unrepairable.map(to_global));
			repair_stats.duplicated.push(...outcome.duplicated.map(to_global));
			repair_stats.residual.push(...outcome.residual);

			result.accumulated_text = join_parts();
			result.remaining = total_blocks - (i + 1);

			post({ status: 'on_chunk', data: result });
		} catch (err) {
			console.warn(`[block_runner] ${label} failed: ${err?.message || err}`);

			parts.push(null);
			failed_blocks.push({ block: i + 1, total: total_blocks, message: err?.message || String(err) });

			result.accumulated_text = join_parts();
			result.remaining = total_blocks - (i + 1);

			post({
				status: 'on_block_error',
				data: {
					message: err?.message || String(err),
					block: i + 1,
					total: total_blocks,
					accumulated_text: result.accumulated_text,
					remaining: result.remaining,
				},
			});
		}
	}

	// a cancel that arrived during the last block: never 'end' (which saves)
	if (is_cancelled()) {
		post({ status: 'cancelled', data: result });
		return result;
	}

	post({ status: 'end', data: result });

	return result;
}; //end run_blocks

// @license-end
