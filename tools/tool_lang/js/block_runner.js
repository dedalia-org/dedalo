// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * BLOCK_RUNNER
 * The worker side of the browser translation, everything except the model itself.
 *
 * tools/tool_lang/translators/browser_transformer/browser_transformer.js loads the
 * model and hands this module a `translate(text, retry_context, label)` function; what
 * happens to the blocks — the order, the corrective retries, the repair of the markers
 * the model lost, the progress messages — lives here, where it can be exercised with a
 * stand-in translate function (the model needs a multi-GB download and a GPU, so the
 * worker file itself is never loaded by a gate).
 *
 * Like placeholders.js, this module must not depend on the Dédalo runtime: it runs
 * inside the Web Worker. Its only import is placeholders.js.
 *
 * A block is (built by browser_translation.js build_blocks):
 *   {
 *     text         : '…[[[1]]]término[[[2]]]…',            // Markdown, tokens local to this block
 *     placeholders : [{ token, kind:'open'|'close'|'atom', pair }],
 *     restore_map  : { '[[[1]]]' : '[[[7]]]' }              // local token → document-wide token
 *   }
 *
 * Messages posted (the worker relays them to the main thread unchanged):
 *   { status: 'on_chunk',       data: { accumulated_text, remaining, repair_stats } }
 *   { status: 'on_block_error', data: { message, block, total, accumulated_text, remaining } }
 *   { status: 'cancelled',      data: { accumulated_text, remaining, repair_stats } }
 *   { status: 'end',            data: { accumulated_text, remaining, repair_stats } }
 *
 * repair_stats = { repaired:string[], unrepairable:string[] } in DOCUMENT-WIDE tokens:
 * every marker WE placed instead of the model. The main thread reports them to the
 * operator; it never treats them as placed by the model.
 *
 * Ported from the v6 worker (d3991c3a66, 2026-07-14: normalize → corrective retry →
 * repair_placeholders → report) onto the TS run loop, whose failed-block contract is
 * stricter than v6's: a block that throws is SKIPPED and reported (on_block_error),
 * and the main thread refuses to save a run that lost a block (v6 kept the block's
 * source text instead).
 *
 * Exports:
 *   MAX_PLACEHOLDER_RETRIES     — corrective rounds before deterministic repair
 *   detect_missing_placeholders — which of a block's markers an output lacks
 *   to_global_tokens            — local → document-wide tokens
 *   process_block               — translate one block, return it with every marker present
 *   run_blocks                  — the block loop and its messages
 */

// imports
import {
	extract_placeholders,
	normalize_placeholders,
	placeholder_re,
	repair_placeholders,
} from './placeholders.js';

/**
 * How many times the model is asked to re-insert the markers it dropped before
 * repair_placeholders() places them itself. Each round is a full generation pass of an
 * in-browser model; the TS worker has asked 3 times since before this port (v6: 2).
 * @type {number}
 */
export const MAX_PLACEHOLDER_RETRIES = 3;

/**
 * DETECT_MISSING_PLACEHOLDERS
 * Which of a block's markers the model failed to reproduce.
 * @param {string} input_text  - Block as sent to the model.
 * @param {string} output_text - Model output, already normalised.
 * @returns {{missing:string[], has_missing:boolean}}
 */
export const detect_missing_placeholders = (input_text, output_text) => {
	const input_ph = extract_placeholders(input_text);
	if (input_ph.length === 0) {
		return { missing: [], has_missing: false };
	}

	const output_set = new Set(extract_placeholders(output_text));
	const missing = input_ph.filter((ph) => !output_set.has(ph));

	return { missing, has_missing: missing.length > 0 };
}; //end detect_missing_placeholders

/**
 * TO_GLOBAL_TOKENS
 * Map a block's local tokens back to the document-wide tokens the main thread uses.
 *
 * A token with no entry in the map is one the model invented; it is left as-is so the
 * main thread can spot it and strip it (restore_placeholders → residual), rather than
 * being silently rewritten to a real marker it was never meant to be.
 * @param {string} text
 * @param {Object} restore_map - local token → global token
 * @returns {string}
 */
export const to_global_tokens = (text, restore_map) => {
	if (!text || !restore_map) {
		return text;
	}

	return text.replace(placeholder_re(), (match) => restore_map[match] || match);
}; //end to_global_tokens

/**
 * PROCESS_BLOCK
 * Translate one block and guarantee that every marker it carried comes back.
 *
 * The escalation, cheapest first:
 *   1. Translate, then normalise the markers the model merely mangled ([[5]], [[[ 5 ]]],
 *      localised digits, escaped brackets) back to [[[n]]].
 *   2. If markers are missing, ask the model again with its failed attempts — up to
 *      MAX_PLACEHOLDER_RETRIES times. A retry is only kept when it recovers ground, so a
 *      worse retry can never make things worse. A retry that throws ends the retries.
 *   3. Whatever is still missing is placed by repair_placeholders() and REPORTED.
 *
 * A failure of the FIRST translation propagates: the caller treats the block as lost.
 *
 * @param {Function} translate - (text, retry_context|null, label) => Promise<string>
 *   retry_context = { failed_attempts: Array<{text, missing}> }
 * @param {Object} block - { text, placeholders, restore_map }
 * @param {Object} [options]
 * @param {string} [options.label='Block'] - Human label for messages, e.g. 'Block 2/5'
 * @param {Function} [options.is_cancelled] - () => boolean; stops the retries early
 * @returns {Promise<{text:string, repaired:string[], unrepairable:string[]}>} in LOCAL tokens.
 */
export const process_block = async (translate, block, options = {}) => {
	const label = options.label || 'Block';
	const is_cancelled =
		typeof options.is_cancelled === 'function' ? options.is_cancelled : () => false;

	// 1. translate
	const raw = await translate(block.text, null, label);
	let text = normalize_placeholders(String(raw ?? ''));

	// 2. ask the model to re-insert the markers it dropped
	const failed_attempts = [];
	for (let attempt = 1; attempt <= MAX_PLACEHOLDER_RETRIES; attempt++) {
		const detection = detect_missing_placeholders(block.text, text);
		if (!detection.has_missing || is_cancelled()) {
			break;
		}

		failed_attempts.push({ text, missing: detection.missing });

		let retry_text;
		try {
			const retry_raw = await translate(
				block.text,
				{ failed_attempts },
				`${label} (retry ${attempt}/${MAX_PLACEHOLDER_RETRIES})`,
			);
			retry_text = normalize_placeholders(String(retry_raw ?? ''));
		} catch (retry_error) {
			// the retry timed out or errored — fall through to deterministic repair
			console.warn(
				`[block_runner] ${label}: retry ${attempt} failed (${retry_error?.message || retry_error})`,
			);
			break;
		}

		const retry_detection = detect_missing_placeholders(block.text, retry_text);

		// only keep a retry that recovered ground; never let it lose more
		if (retry_detection.missing.length < detection.missing.length) {
			text = retry_text;
		}
		if (!retry_detection.has_missing) {
			break;
		}
	}

	// 3. place whatever the model would not, and say so
	return repair_placeholders(block.text, text, block.placeholders);
}; //end process_block

/**
 * RUN_BLOCKS
 * Translate every block in order, posting progress as each one finishes.
 *
 * Blocks are processed one by one (not batched) so partial results stream as soon as a
 * block is done. A block whose translation throws is SKIPPED — its text is not in
 * accumulated_text — and reported with 'on_block_error'; the main thread refuses to
 * save a run that lost a block (browser_translation.js, REFUSAL 1).
 *
 * @param {Object} options
 * @param {Array}    options.blocks       - [{text, placeholders, restore_map}]
 * @param {Function} options.translate    - (text, retry_context|null, label) => Promise<string>
 * @param {Function} options.post         - (message) => void; the worker passes self.postMessage
 * @param {Function} [options.is_cancelled] - () => boolean, checked between blocks
 * @returns {Promise<Object>} The final result object (the 'end' or 'cancelled' payload).
 */
export const run_blocks = async (options) => {
	const blocks = options.blocks;
	const translate = options.translate;
	const post = options.post;
	const is_cancelled =
		typeof options.is_cancelled === 'function' ? options.is_cancelled : () => false;

	const total_blocks = blocks.length;

	// every marker WE placed rather than the model, in document-wide tokens
	const repair_stats = {
		repaired: [],
		unrepairable: [],
	};

	const result = {
		accumulated_text: '',
		remaining: total_blocks,
		repair_stats: repair_stats,
	};

	for (let i = 0; i < total_blocks; i++) {
		// check the cancel flag between blocks
		if (is_cancelled()) {
			post({ status: 'cancelled', data: result });
			return result;
		}

		const block = blocks[i];
		const label = `Block ${i + 1}/${total_blocks}`;

		try {
			const outcome = await process_block(translate, block, { label, is_cancelled });

			// joined with the paragraph separator the blocks were split on — concatenating
			// them bare would weld two paragraphs together in markdown_to_html
			const global_text = to_global_tokens(outcome.text, block.restore_map);
			result.accumulated_text += (result.accumulated_text ? '\n\n' : '') + global_text;

			for (const token of outcome.repaired) {
				repair_stats.repaired.push(block.restore_map?.[token] || token);
			}
			for (const token of outcome.unrepairable) {
				repair_stats.unrepairable.push(block.restore_map?.[token] || token);
			}

			result.remaining = total_blocks - (i + 1);

			post({ status: 'on_chunk', data: result });
		} catch (err) {
			// per-block failure — report and continue with the remaining blocks.
			// The block's text is NOT in accumulated_text: the main thread refuses the run.
			console.warn(`[block_runner] ${label} failed: ${err?.message || err}`);

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

	post({ status: 'end', data: result });

	return result;
}; //end run_blocks

// @license-end
