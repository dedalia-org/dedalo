// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * PLACEHOLDERS
 * Token-level handling of the [[[n]]] markers used to shield Dédalo inline marks
 * from the translation model.
 *
 * This module knows about *tokens*, not about Dédalo marks. The mapping between a
 * token and the mark it stands for lives in browser_translation.js (the only file
 * that imports tr.js). Keeping the two apart lets the Web Worker — which must never
 * depend on the Dédalo runtime — import this module directly.
 *
 * Both the main thread (browser_translation.js) and the worker side (block_runner.js,
 * imported by tools/tool_lang/translators/browser_transformer/browser_transformer.js)
 * import from here, so the token format is defined once. Ported from v6
 * (d3991c3a66, 2026-07-14). Differences from v6: the lint shape (exec loops → matchAll,
 * the non-ASCII class spelled without a control character), and two additions from the
 * A1-02 review — a token is never placed inside a raw HTML tag or a Markdown link target
 * (protected_ranges), and has_token_shaped_text lets the caller refuse a source whose own
 * text would be read back as a token.
 *
 * A *descriptor* carries the structural knowledge the repair needs:
 *
 *   { token : '[[[1]]]', kind : 'open' | 'close' | 'atom', pair : '[[[2]]]' | null }
 *
 * 'open'/'close' describe the two halves of a paired mark (index, reference); every
 * other mark (TC, note, person, svg, geo, page, lang) is an 'atom'. That distinction
 * is what makes repair deterministic: when a close is dropped but its open survived,
 * we know exactly what is missing and roughly where it belongs, instead of having to
 * guess from character offsets.
 *
 * Exports:
 *   make_placeholder      — n → '[[[n]]]'
 *   placeholder_re        — a fresh /g regex (never share one: lastIndex is stateful)
 *   extract_placeholders  — every [[[n]]] in a string, in order of appearance
 *   normalize_placeholders— repair the forms the model mangles ([[5]], [[[ 5 ]]], [[[५]]] …)
 *   has_token_shaped_text — does the text itself contain something normalising reads as a token
 *   repair_placeholders   — re-insert the tokens the model dropped
 */

/**
 * Regex source for a well-formed token. Kept as a string so callers can build a
 * fresh RegExp per use — a shared /g regex carries lastIndex between calls and
 * silently skips every other match.
 */
const TOKEN_SOURCE = '\\[\\[\\[(\\d+)\\]\\]\\]';

/**
 * MAKE_PLACEHOLDER
 * @param {number} n - 1-based placeholder index.
 * @returns {string} The token, e.g. '[[[7]]]'.
 */
export const make_placeholder = (n) => `[[[${n}]]]`; //end make_placeholder

/**
 * PLACEHOLDER_RE
 * @returns {RegExp} A new global regex matching a well-formed [[[n]]] token.
 */
export const placeholder_re = () => new RegExp(TOKEN_SOURCE, 'g'); //end placeholder_re

/**
 * EXTRACT_PLACEHOLDERS
 * @param {string} text
 * @returns {string[]} Every [[[n]]] token in order of appearance (duplicates included).
 */
export const extract_placeholders = (text) => {
	if (!text) {
		return [];
	}

	return text.match(placeholder_re()) || [];
}; //end extract_placeholders

/**
 * NORMALIZE_DIGITS
 * Convert non-ASCII digits (Arabic, Persian, Devanagari, Thai, …) to ASCII 0-9.
 * The model sometimes localises the numbers inside a token when translating into a
 * language that uses a different numeral system.
 * @param {string} str
 * @returns {string}
 */
const normalize_digits = (str) => {
	const blocks = [
		[0x0660, 0x0669],
		[0x06f0, 0x06f9],
		[0x0966, 0x096f],
		[0x0ae6, 0x0aef],
		[0x0be6, 0x0bef],
		[0x0c66, 0x0c6f],
		[0x0ce6, 0x0cef],
		[0x0d66, 0x0d6f],
		[0x0e50, 0x0e59],
		[0x0ed0, 0x0ed9],
		[0x1040, 0x1049],
		[0x17e0, 0x17e9],
		[0x1810, 0x1819],
	];

	// every non-ASCII code unit (U+0080 and up); ASCII passes through untouched
	return str.replace(/[\u0080-\uffff]/g, (ch) => {
		const code = ch.charCodeAt(0);
		for (const [start, end] of blocks) {
			if (code >= start && code <= end) {
				return String(code - start);
			}
		}
		return ch;
	});
}; //end normalize_digits

/**
 * NORMALIZE_PLACEHOLDERS
 * Repair the token forms the model produces instead of the exact [[[n]]] it was given.
 *
 * Observed corruptions:
 *   - backslash-escaped brackets: \[\[\[5\]\]\]
 *   - too few / too many brackets: [[5]] , [[[[5]]]]
 *   - padding: [[[ 5 ]]]
 *   - localised numerals: [[[५]]]
 *
 * Note this only fixes tokens the model *emitted in some form*. Tokens it dropped
 * entirely are the job of repair_placeholders().
 *
 * @param {string} text - Raw model output.
 * @returns {string} Text with every recognisable token normalised to [[[n]]].
 */
export const normalize_placeholders = (text) => {
	if (!text) {
		return text;
	}

	// drop backslashes the model added in front of brackets, so the patterns below
	// see the bracket structure rather than its escaped form
	let out = text.replace(/\\([[\]])/g, '$1');

	// quad brackets → triple
	out = out.replace(/\[\[\[\[\s*([^\]\s]+)\s*\]\]\]\]/g, (match, id) => {
		const n = normalize_digits(id);
		return /^\d+$/.test(n) ? make_placeholder(n) : match;
	});

	// double brackets → triple (only when not already part of a triple)
	out = out.replace(/(?<!\[)\[\[\s*([^\]\s]+)\s*\]\](?!\])/g, (match, id) => {
		const n = normalize_digits(id);
		return /^\d+$/.test(n) ? make_placeholder(n) : match;
	});

	// padding and localised numerals inside an otherwise well-formed token
	out = out.replace(/\[\[\[([^\]]+)\]\]\]/g, (match, inner) => {
		const n = normalize_digits(inner.trim());
		return /^\d+$/.test(n) ? make_placeholder(n) : match;
	});

	return out;
}; //end normalize_placeholders

/**
 * HAS_TOKEN_SHAPED_TEXT
 * Does the text, apart from its real tokens, contain anything normalize_placeholders()
 * would turn into a token?
 *
 * The token namespace is shared with the record's own text: '[[2]]', '[[[ 2 ]]]' or the
 * escaped '\[\[2\]\]' typed by a person would come back from the model as the token
 * [[[2]]] — stealing mark 2's place, or duplicating it. Such a source cannot be
 * translated safely with bracket tokens, so the caller refuses it before the model runs
 * (A1-02 review). The real tokens are removed first (not replaced by a space), so text
 * that would only BECOME token-shaped once the model dropped a token is caught too.
 * @param {string} text - The text the model will receive, real tokens included.
 * @returns {boolean}
 */
export const has_token_shaped_text = (text) => {
	if (!text) {
		return false;
	}

	return extract_placeholders(normalize_placeholders(text.replace(placeholder_re(), ''))).length > 0;
}; //end has_token_shaped_text

/**
 * SPLIT_SENTENCES
 * Split text into sentences, keeping each one's absolute offsets.
 *
 * Sentence granularity is what makes atom repair stable: translation models render
 * a source sentence as a target sentence in the overwhelming majority of cases, so
 * "the third sentence" survives translation even though character offsets do not.
 *
 * @param {string} text
 * @returns {Array<{start:number, end:number}>} Never empty (the whole text is one
 *   sentence when no terminator is found).
 */
const split_sentences = (text) => {
	const sentences = [];

	let last = 0;
	for (const match of text.matchAll(/[.!?…]+(?:\s+|$)/g)) {
		const end = match.index + match[0].length;
		sentences.push({ start: last, end: end });
		last = end;
	}
	if (last < text.length) {
		sentences.push({ start: last, end: text.length });
	}
	if (sentences.length === 0) {
		sentences.push({ start: 0, end: text.length });
	}

	return sentences;
}; //end split_sentences

/**
 * SENTENCE_AT
 * @param {Array} sentences - Output of split_sentences.
 * @param {number} offset
 * @returns {{start:number, end:number}} The sentence containing offset (last one if past the end).
 */
const sentence_at = (sentences, offset) => {
	for (const sentence of sentences) {
		if (offset < sentence.end) {
			return sentence;
		}
	}

	return sentences[sentences.length - 1];
}; //end sentence_at

/**
 * COUNT_WORDS
 * Count whitespace-delimited runs in text[start, end).
 *
 * A token glued to a word ('término[[[2]]]') is part of that word's run and does not
 * add to the count — which is the common case and keeps source/target counts comparable.
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
const count_words = (text, start, end) => {
	const slice = text.slice(start, end);
	const words = slice.match(/\S+/g);

	return words ? words.length : 0;
}; //end count_words

/**
 * OFFSET_AFTER_WORDS
 * Absolute offset immediately after the n-th word of text[start, end).
 * n<=0 returns `start`; n beyond the last word returns `end`.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} n
 * @returns {number}
 */
const offset_after_words = (text, start, end, n) => {
	if (n <= 0) {
		return start;
	}

	const slice = text.slice(start, end);

	let count = 0;
	for (const match of slice.matchAll(/\S+/g)) {
		count++;
		if (count === n) {
			return start + match.index + match[0].length;
		}
	}

	return end;
}; //end offset_after_words

/**
 * SKIP_SPACES_FORWARD
 * Advance past any whitespace at `offset`.
 *
 * offset_after_words() lands immediately behind a word, which is where a *close* or an
 * atom belongs ('ballena[[[2]]] es'). An *open* has to sit in front of the word it wraps
 * ('la [[[1]]]ballena'), so it skips the space first — otherwise it would trail the
 * previous word and the span would start one word too early.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
const skip_spaces_forward = (text, offset) => {
	let i = offset;
	while (i < text.length && /\s/.test(text[i])) {
		i++;
	}

	return i;
}; //end skip_spaces_forward

/**
 * PROTECTED_RANGES
 * The spans of a text a token must never be placed inside:
 *   - an existing token: splitting one in half destroys two marks;
 *   - a raw HTML tag (<span style="…">): a mark inside a tag is not text — the browser
 *     parses it as an attribute name and the mark is gone from the record's text;
 *   - a Markdown link or image target (](…)): a mark there corrupts the URL.
 * Word counting cannot see any of these (a tag's attributes are whitespace-separated
 * "words"), so a placement computed in words can land inside one. Added in the TS port
 * (A1-02 review): v6 d3991c3a66 only avoided splitting a token.
 * @param {string} text
 * @returns {Array<{start:number, end:number}>}
 */
const protected_ranges = (text) => {
	const ranges = [];
	for (const pattern of [placeholder_re(), /<[^<>]*>/g, /\]\([^)]*\)/g]) {
		for (const match of text.matchAll(pattern)) {
			ranges.push({ start: match.index, end: match.index + match[0].length });
		}
	}

	return ranges;
}; //end protected_ranges

/**
 * AVOID_TOKEN_OVERLAP
 * Never place a token inside a protected range (see protected_ranges): if `offset`
 * falls strictly inside one, move it to just after it — repeated, because the end of one
 * range can sit inside another.
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
const avoid_token_overlap = (text, offset) => {
	const ranges = protected_ranges(text);

	let current = offset;
	let moved = true;
	while (moved) {
		moved = false;
		for (const range of ranges) {
			if (current > range.start && current < range.end) {
				current = range.end;
				moved = true;
			}
		}
	}

	return current;
}; //end avoid_token_overlap

/**
 * PAIR_INSERT_OFFSET
 * Where to re-insert a dropped half of a paired mark, given that its partner survived.
 *
 * The word gap between open and close in the source is the best available estimate of
 * the span's length in the target: translation changes the words, but a two-word term
 * stays roughly a two-word term. So we measure the gap in the source and reapply it
 * from the surviving anchor, clamped to the anchor's sentence.
 *
 * @param {string} input_text  - Source block (contains both tokens).
 * @param {string} output_text - Current model output (contains the anchor only).
 * @param {Object} descriptor  - { token, kind, pair } for the missing token.
 * @returns {number} Insertion offset, or -1 when the anchor cannot be located.
 */
const pair_insert_offset = (input_text, output_text, descriptor) => {
	const token = descriptor.token;
	const anchor = descriptor.pair;

	const token_in_input = input_text.indexOf(token);
	const anchor_in_input = input_text.indexOf(anchor);
	const anchor_in_output = output_text.indexOf(anchor);
	if (token_in_input === -1 || anchor_in_input === -1 || anchor_in_output === -1) {
		return -1;
	}

	const sentences = split_sentences(output_text);
	const anchor_sentence = sentence_at(sentences, anchor_in_output);

	if (descriptor.kind === 'close') {
		// the anchor is the open: count the words it wraps in the source, then walk the
		// same number of words forward from the open in the translation
		const open_end = anchor_in_input + anchor.length;
		const gap = count_words(input_text, open_end, token_in_input);

		const from = anchor_in_output + anchor.length;

		return avoid_token_overlap(
			output_text,
			offset_after_words(output_text, from, anchor_sentence.end, gap),
		);
	}

	// kind==='open': the anchor is the close. Count the words the span wraps in the
	// source, then step back that many words from the close in the translation.
	const open_end = token_in_input + token.length;
	const gap = count_words(input_text, open_end, anchor_in_input);

	const words_before_anchor = count_words(output_text, anchor_sentence.start, anchor_in_output);

	const target = offset_after_words(
		output_text,
		anchor_sentence.start,
		anchor_in_output,
		Math.max(0, words_before_anchor - gap),
	);

	return avoid_token_overlap(output_text, skip_spaces_forward(output_text, target));
}; //end pair_insert_offset

/**
 * SENTENCE_ALIGNED_OFFSET
 * Where to re-insert a dropped token that has no surviving anchor.
 *
 * Locate the token's sentence in the source and its word position within it, then
 * place it at the proportional word position of the *corresponding* sentence in the
 * translation. Falls back to a whole-block proportional position when the sentence
 * counts diverge (the model merged or split sentences).
 *
 * @param {string} input_text
 * @param {string} output_text
 * @param {string} token
 * @param {string} kind - 'open' | 'close' | 'atom'; an open is nudged in front of its word.
 * @returns {number} Insertion offset, or -1 when the token is absent from the source.
 */
const sentence_aligned_offset = (input_text, output_text, token, kind) => {
	const token_in_input = input_text.indexOf(token);
	if (token_in_input === -1) {
		return -1;
	}

	const in_sentences = split_sentences(input_text);
	const out_sentences = split_sentences(output_text);

	// window to place within: the matching sentence when the model kept the sentence
	// count (the usual case), otherwise the whole block
	let in_window;
	let out_window;
	if (in_sentences.length === out_sentences.length) {
		const found = in_sentences.findIndex((sentence) => token_in_input < sentence.end);
		const index = found === -1 ? in_sentences.length - 1 : found;
		in_window = in_sentences[index];
		out_window = out_sentences[index];
	} else {
		in_window = { start: 0, end: input_text.length };
		out_window = { start: 0, end: output_text.length };
	}

	const words_before = count_words(input_text, in_window.start, token_in_input);
	const in_words = count_words(input_text, in_window.start, in_window.end);
	const out_words = count_words(output_text, out_window.start, out_window.end);

	const target_word = in_words > 0 ? Math.round((words_before * out_words) / in_words) : 0;

	let target = offset_after_words(output_text, out_window.start, out_window.end, target_word);
	if (kind === 'open') {
		target = skip_spaces_forward(output_text, target);
	}

	return avoid_token_overlap(output_text, target);
}; //end sentence_aligned_offset

/**
 * REPAIR_PLACEHOLDERS
 * Re-insert the tokens the model dropped from its translation.
 *
 * The ladder, in order of confidence:
 *
 *   1. Pair repair — a dropped half whose partner survived is placed relative to that
 *      partner, using the source's word gap. Repeated until it stops making progress,
 *      because re-inserting an open turns it into an anchor for its own close.
 *   2. Sentence-aligned placement — everything else (atoms, and pairs where both halves
 *      were dropped) is placed in the corresponding target sentence.
 *   3. Pair repair again — an open placed in step 2 can now anchor its close.
 *   4. Whatever is still missing is appended at the end and reported as unrepairable.
 *
 * Callers must run normalize_placeholders() on `output_text` first, otherwise tokens the
 * model merely mangled will be mistaken for tokens it dropped.
 *
 * @param {string} input_text  - The block as sent to the model.
 * @param {string} output_text - The model's (normalised) translation of that block.
 * @param {Array}  descriptors - [{ token, kind, pair }] for every token in the block.
 * @returns {{ text:string, repaired:string[], unrepairable:string[] }}
 *   `repaired` and `unrepairable` are both *uncertain*: the model did not place these,
 *   we did. The caller surfaces them so the user can review before saving.
 */
export const repair_placeholders = (input_text, output_text, descriptors) => {
	const repaired = [];
	const unrepairable = [];

	let result = output_text;

	// tokens present in the source block but absent from the translation, in source order
	const missing = (descriptors || [])
		.filter((item) => input_text.indexOf(item.token) !== -1 && result.indexOf(item.token) === -1)
		.sort((a, b) => input_text.indexOf(a.token) - input_text.indexOf(b.token));

	if (missing.length === 0) {
		return { text: result, repaired, unrepairable };
	}

	const by_token = new Map((descriptors || []).map((item) => [item.token, item]));
	const pending = new Set(missing.map((item) => item.token));

	// 1 & 3. pair repair — loops because each insertion can unlock another
	const pair_repair_pass = () => {
		let progress = true;
		while (progress) {
			progress = false;
			for (const token of Array.from(pending)) {
				const descriptor = by_token.get(token);
				if (!descriptor || !descriptor.pair || result.indexOf(descriptor.pair) === -1) {
					continue;
				}

				const offset = pair_insert_offset(input_text, result, descriptor);
				if (offset === -1) {
					continue;
				}

				result = result.slice(0, offset) + token + result.slice(offset);
				pending.delete(token);
				repaired.push(token);
				progress = true;
			}
		}
	};

	pair_repair_pass();

	// 2. sentence-aligned placement for everything with no surviving anchor
	for (const token of Array.from(pending)) {
		const descriptor = by_token.get(token);
		const offset = sentence_aligned_offset(input_text, result, token, descriptor?.kind);
		if (offset === -1) {
			continue;
		}

		result = result.slice(0, offset) + token + result.slice(offset);
		pending.delete(token);
		repaired.push(token);
	}

	pair_repair_pass();

	// 4. nothing placed it — keep the mark rather than lose it, and say so
	for (const token of pending) {
		result += token;
		unrepairable.push(token);
	}

	return { text: result, repaired, unrepairable };
}; //end repair_placeholders

// @license-end
