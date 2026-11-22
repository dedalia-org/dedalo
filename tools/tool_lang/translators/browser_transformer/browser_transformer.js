// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0


/**
 * Browser Translation Worker (Web Worker)
 *
 * Runs a translation model locally in the browser via HuggingFace Transformers and the ONNX
 * runtime. Receives Markdown blocks from the main thread, translates each block
 * sequentially, and streams results back as they complete.
 *
 * Which model is DATA: the main thread sends the selected definition from the tool config
 * (register.json → browser_transformer.models; the catalogue and its fields are described in
 * ../../js/browser_models.js). Only how a KIND of model is fed is code — SHAPE_HANDLERS below.
 * (v6 40bf5eaacf + 23010156ad.)
 *
 * Communication protocol (postMessage):
 *   Main → Worker:
 *     { options: { blocks[], sourceLangCode, targetLangCode, device, dtype?, engine?, model? } }
 *     { cancel: true }                     – abort in-progress translation
 *   Worker → Main:
 *     { status: 'init',           data: { progress, status, device, file, engine } }        – model loading
 *     { status: 'on_chunk',       data: { accumulated_text, remaining, repair_stats, failed_blocks } }
 *     { status: 'on_block_error', data: { message, block, total, accumulated_text, remaining } }
 *     { status: 'end',            data: { accumulated_text, remaining, repair_stats, failed_blocks } }
 *     { status: 'cancelled',      data: { accumulated_text, remaining, repair_stats, failed_blocks } }
 *     { status: 'error',          data: { message, code?, name?, stack? } }
 *   An 'error' with a `code` (unsupported_pair | needs_webgpu | model_too_large) is a SOFT
 *   error: the user's choice cannot run here, the worker is still fine (v6).
 *
 * The block loop, the repetition escalation, the repair of the tokens the model lost and the
 * re-attachment of the hoisted ones live in ../../js/block_runner.js (testable without the
 * model); this file owns only the model: choosing, loading and calling it.
 *
 * THE MODEL CANNOT BE INSTRUCTED. See translate_text.
 */

// The ONE in-browser AI runtime this install serves: the digest-pinned
// transformers.js bundle (vendor/transformers) through the client-lib registry — the same
// module browser_whisper and remove_background load, so one page never runs two
// copies of the runtime. (Until P2-5-residue / CLI-12 this imported a committed
// copy under ./lib/, byte-identical to the 4.2.0 dist but outside every
// integrity mechanism; before RC-01 it imported straight from a CDN.)
import { pipeline, env } from '/dedalo/lib/transformers/dist/transformers.js';
// The block loop + marker repair (testable without the model): ../../js/block_runner.js.
import { run_blocks } from '../../js/block_runner.js';
// The catalogue fallback for a stored config without `models` (one copy, gated).
import { BROWSER_MODELS } from '../../js/browser_models.js';

// RC-01 (2026-07-28 audit): PIN the onnxruntime-web runtime to THIS install.
// Without wasmPaths, transformers.js loads its WASM glue (.mjs + .wasm) from
// cdn.jsdelivr.net at runtime — third-party CODE executing in the archivist's
// session, and impossible in an air-gapped archive. Point it at the same local
// onnxruntime the browser_whisper transcriber uses (served from
// node_modules/onnxruntime-web via the client-libs registry). The enforcing CSP
// (script-src/connect-src 'self') also blocks the CDN fetch, so an un-pinned
// build now fails loudly instead of silently phoning home.
if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
	env.backends.onnx.wasm.wasmPaths = new URL('/dedalo/lib/onnxruntime/dist/', self.location.origin).href;
}
env.allowLocalModels	= false;
env.allowRemoteModels	= true;	// "remote" here means our OWN origin (below)
// Model weights from THIS INSTALL'S MODEL STORE only (/dedalo/ai_models/ —
// src/core/ai/model_store.ts: session-gated, digest-checked against
// model_pins.json, seeded by the operator with scripts/fetch_ai_models.ts or
// rsync). The same door browser_whisper and remove_background use. Every model of
// the catalogue is pinned there (the opus pairs that exist on the hub included), so
// a model that is not in the store answers 404 — reported as 'unsupported_pair'.
// Model files never live in the code tree.
env.remoteHost			= new URL('/dedalo/ai_models/', self.location.origin).href;
env.remotePathTemplate	= '{model}/';
env.useBrowserCache		= true;	// a second translation must not re-download

/**
 * NLLB / FLORES-200 language codes, keyed by the ISO 639-1 code dedalo_to_locale emits.
 * Covers every language Dédalo ships labels for. (v6)
 * @type {Object<string,string>}
 */
const NLLB_LANGS = {
	en : 'eng_Latn',
	es : 'spa_Latn',
	fr : 'fra_Latn',
	it : 'ita_Latn',
	pt : 'por_Latn',
	ca : 'cat_Latn',
	de : 'deu_Latn',
	ne : 'npi_Deva',
	ar : 'arb_Arab',
	el : 'ell_Grek',
	eu : 'eus_Latn'
};

/**
 * English language names for the instruct model's system prompt — 'Spanish → Basque' is far
 * clearer to a general LLM than 'es → eu'. Falls back to the raw code. (v6)
 * @type {Object<string,string>}
 */
const LANG_NAMES = {
	en : 'English', es : 'Spanish', fr : 'French', it : 'Italian', pt : 'Portuguese',
	ca : 'Catalan', de : 'German', ne : 'Nepali', ar : 'Arabic', el : 'Greek', eu : 'Basque'
};

/**
 * MADLAD target-language codes (it encodes only the TARGET, as a <2xx> prefix; the source is
 * auto-detected). Every value was verified present in the model's vocabulary. (v6)
 * @type {Object<string,string>}
 */
const MADLAD_TARGETS = {
	en : '<2en>', es : '<2es>', fr : '<2fr>', it : '<2it>', pt : '<2pt>', ca : '<2ca>',
	de : '<2de>', ne : '<2ne>', ar : '<2ar>', el : '<2el>', eu : '<2eu>'
};

/**
 * ISO 639-1 codes Dédalo can emit (the keys of NLLB_LANGS).
 * @type {Set<string>}
 */
const KNOWN_LANGS = new Set(Object.keys(NLLB_LANGS));

/**
 * QWEN_SYSTEM_PROMPT
 * The instruction turn for a general instruct model (Qwen3), which — unlike TranslateGemma —
 * has a real `system` role it obeys; the segment goes in the user turn untouched. The marker
 * rule is stated IN WORDS with no worked example: an example token is exactly what got copied
 * into the output and mapped back to a real Dédalo mark. (v6)
 * @param {string} src - source ISO code
 * @param {string} tgt - target ISO code
 * @returns {string}
 */
const qwen_system_prompt = function(src, tgt) {

	const source = LANG_NAMES[src] || src;
	const target = LANG_NAMES[tgt] || tgt;

	return [
		`You are a professional translator. Translate the user's text from ${source} to ${target}.`,
		'Output only the translation — no preamble, no notes, no explanation, no quotation marks.',
		'Preserve the meaning, tone and register; this is transcribed speech and archival text, not to be summarised.',
		'Some text contains placeholders written as triple square brackets around a number, for example three open brackets, a number, three close brackets. Keep every placeholder exactly as written and in place: never translate, renumber, add or remove one.',
		'Keep Markdown emphasis (*, **, __) exactly as in the source; do not add any that is not there.'
	].join('\n');
};

/**
 * SHAPE_HANDLERS
 * How each KIND of model is fed its input and read back. (v6 40bf5eaacf)
 *
 *   chat           — a general instruct model (Qwen): rules in a SYSTEM turn, the segment in
 *                    the USER turn.
 *   chat_gemma     — TranslateGemma: content {source_lang_code, target_lang_code, text}; the
 *                    text IS the source, never a prompt.
 *   seq2seq_lang   — NLLB: raw text with src_lang/tgt_lang (FLORES codes).
 *   seq2seq_prefix — MADLAD: a <2xx> target token prepended to the text.
 *   seq2seq_pair   — Marian/opus-mt: the model IS the language pair, no lang arguments.
 *
 * Adding a model that fits an existing shape is a register.json edit alone.
 * Signature: (translator, text, src, tgt, generation) => Promise<string>
 */
const SHAPE_HANDLERS = {

	chat : async function(translator, text, src, tgt, generation) {
		const messages = [
			{ role : 'system', content : qwen_system_prompt(src, tgt) },
			{ role : 'user',   content : text }
		];
		const output = await translator(messages, generation);
		const generated_text = output[0].generated_text;
		return generated_text[generated_text.length - 1].content;
	},

	chat_gemma : async function(translator, text, src, tgt, generation) {
		// the text field is the SOURCE TEXT, not a prompt — see translate_text
		const messages = [{
			role    : 'user',
			content : [{ type : 'text', source_lang_code : src, target_lang_code : tgt, text : text }]
		}];
		const output = await translator(messages, generation);
		const generated_text = output[0].generated_text;
		return generated_text[generated_text.length - 1].content;
	},

	seq2seq_lang : async function(translator, text, src, tgt, generation) {
		const output = await translator(text, { ...generation, src_lang : NLLB_LANGS[src], tgt_lang : NLLB_LANGS[tgt] });
		return output[0].translation_text;
	},

	seq2seq_prefix : async function(translator, text, src, tgt, generation) {
		const output = await translator(`${MADLAD_TARGETS[tgt]} ${text}`, generation);
		return output[0].generated_text;
	},

	seq2seq_pair : async function(translator, text, src, tgt, generation) {
		// the model IS the pair — no lang arguments
		const output = await translator(text, generation);
		return output[0].translation_text;
	}
};

/**
 * SUPPORTS_LANGS
 * Does a model cover this pair, judged from its `langs` value alone? (v6)
 *   'all'   — every language Dédalo emits;
 *   'pairs' — any distinct pair of known languages is PLAUSIBLE; whether the model exists is
 *             settled by the load (a 404 → 'unsupported_pair');
 *   Array   — an explicit ISO allow-list.
 * @param {'all'|'pairs'|string[]} langs
 * @param {string} src
 * @param {string} tgt
 * @returns {boolean}
 */
const supports_langs = function(langs, src, tgt) {

	if (langs==='all') {
		return KNOWN_LANGS.has(src) && KNOWN_LANGS.has(tgt);
	}
	if (langs==='pairs') {
		return src!==tgt && KNOWN_LANGS.has(src) && KNOWN_LANGS.has(tgt);
	}
	if (Array.isArray(langs)) {
		return langs.includes(src) && langs.includes(tgt);
	}
	return false;
};

/**
 * RESOLVE_MODEL_ID
 * Fill {src}/{tgt} in a model id (opus is one model per pair).
 * @param {string} template
 * @param {string} src
 * @param {string} tgt
 * @returns {string}
 */
const resolve_model_id = function(template, src, tgt) {
	return String(template).replace('{src}', src).replace('{tgt}', tgt);
};

/**
 * IS_MODEL_NOT_FOUND
 * Did the load fail because the model is not there (vs a network drop, an out-of-memory)?
 * transformers.js has no typed error for it, so the message is matched. (v6)
 * @param {Error} error
 * @returns {boolean}
 */
const is_model_not_found = function(error) {

	const message = String(error?.message || error).toLowerCase();

	return message.includes('could not locate')
		|| message.includes('not found')
		|| message.includes('404')
		|| message.includes('unauthorized')
		|| message.includes('failed to fetch');
};

/**
 * IS_ALLOCATION_FAILURE
 * Did the load fail because the model does not fit in memory (MADLAD-400 3B has one decoder
 * buffer larger than most GPUs allow)? (v6)
 * @param {Error} error
 * @returns {boolean}
 */
const is_allocation_failure = function(error) {

	const message = String(error?.message || error).toLowerCase();

	return message.includes('failed to allocate')
		|| message.includes("can't create a session")
		|| message.includes('cannot create a session')
		|| message.includes('out of memory')
		|| message.includes('buffer of size')
		|| message.includes('oom');
};

/**
 * Hard ceiling on generated tokens — a backstop; the real budget comes from the source
 * length (max_new_tokens_for). The model stops at its end token well before it. (v6)
 */
const MAX_NEW_TOKENS = 2048;

/**
 * Output token budget = source CHARACTERS × this, plus a margin. Characters, not source
 * tokens: a compact Latin source under-counts what a Devanagari or Arabic target needs, and
 * budgeting from tokens truncated those translations mid-sentence. (v6)
 */
const OUTPUT_TOKENS_PER_SOURCE_CHAR	= 4.0;
const NEW_TOKENS_MARGIN				= 64;

/**
 * Per-block timeout in milliseconds; a block exceeding it is a failure.
 */
const BLOCK_TIMEOUT_MS = 120_000;

/**
 * Sampling settings when an escalation asks for sampling without giving them (v6).
 */
const RETRY_TEMPERATURE	= 0.3;
const RETRY_TOP_P		= 0.9;

/**
 * Cached pipeline instance — reused across translation requests.
 * @type {Function|null}
 */
let cached_translator = null;

/**
 * engine:model_id:device:dtype of the cached pipeline. Any change throws the cache away —
 * silently reusing the previous model would make the selector look like it does nothing. (v6)
 * @type {string|null}
 */
let cached_signature = null;

/**
 * Flag set by the main thread to cancel an in-progress translation.
 * @type {boolean}
 */
let cancelled = false;


// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wrap a promise with a timeout.
 * @param {Promise} promise
 * @param {number}  ms    - Timeout in milliseconds
 * @param {string}  label - Description for the timeout error message
 * @returns {Promise}
 */
function with_timeout(promise, ms, label) {
	let timerId;
	const timer = new Promise((_, reject) => {
		timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timer]).finally(() => clearTimeout(timerId));
}

/**
 * MAX_NEW_TOKENS_FOR
 * How many tokens this segment may generate (see OUTPUT_TOKENS_PER_SOURCE_CHAR). Segments are
 * small, so the budget is small, so a loop cannot run away. (v6)
 * @param {string} text
 * @returns {number}
 */
function max_new_tokens_for(text) {
	return Math.min(Math.ceil(text.length * OUTPUT_TOKENS_PER_SOURCE_CHAR) + NEW_TOKENS_MARGIN, MAX_NEW_TOKENS);
}

/**
 * SOFT_ERROR
 * Post a soft error: the user's choice cannot run here; the worker stays usable. (v6)
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function soft_error(code, message) {
	self.postMessage({ status : 'error', data : { message, code } });
}

/**
 * LOAD_PIPELINE
 * @param {Object} model
 * @param {string} model_id
 * @param {string} device
 * @param {string} dtype
 * @returns {Promise<Function>}
 */
function load_pipeline(model, model_id, device, dtype) {
	return pipeline(model.task, model_id, {
		device : device,
		dtype  : dtype,
		progress_callback: ({ progress, status, file }) => {
			// Relay download/compile progress to the UI thread
			self.postMessage({
				status : 'init',
				data   : { progress, status, device, file, engine : model.name }
			});
		}
	});
}


// ── Message handler ────────────────────────────────────────────────────────

self.onmessage = async (e) => {

	// ── Cancel command ──────────────────────────────────────────────────
	if (e.data.cancel) {
		cancelled = true;
		return;
	}

	// ── Validate input ──────────────────────────────────────────────────
	const options = e.data?.options;
	if (!options || !Array.isArray(options.blocks) || options.blocks.length === 0) {
		self.postMessage({
			status : 'error',
			data   : { message: 'Invalid or missing options.blocks' }
		});
		return;
	}
	if (typeof options.blocks[0]?.text !== 'string') {
		self.postMessage({
			status : 'error',
			data   : { message: 'options.blocks must be objects: { text, placeholders, restore_map }' }
		});
		return;
	}

	const source_lang_code = options.sourceLangCode || 'en';
	const target_lang_code = options.targetLangCode || 'es';
	const device           = options.device || 'webgpu';

	// The model DEFINITION comes from the tool config via the main thread; a name alone
	// (a stored config without `models`) is resolved against the shipped catalogue. (v6)
	const model = options.model
		|| BROWSER_MODELS.find(item => item.name===options.engine)
		|| BROWSER_MODELS[0];
	const engine_name = model.name;

	const handler = SHAPE_HANDLERS[model.shape];
	if (!handler) {
		self.postMessage({
			status : 'error',
			data   : { message: `Model '${engine_name}' has an unknown shape '${model.shape}'. Known: ${Object.keys(SHAPE_HANDLERS).join(', ')}` }
		});
		return;
	}

	// refuse a pair the model KNOWS it cannot do, before touching the network
	if (!supports_langs(model.langs, source_lang_code, target_lang_code)) {
		soft_error('unsupported_pair', `The '${engine_name}' model does not support ${source_lang_code} → ${target_lang_code}.`);
		return;
	}

	// a multi-gigabyte model cannot run on the WASM (CPU) backend: wasm32 caps the address
	// space at 4 GB and a 4B model plus its KV cache overruns it. Refuse before loading. (v6)
	if (model.requires_webgpu) {
		const webgpu_available = (typeof navigator!=='undefined') && !!navigator.gpu;
		if (device!=='webgpu' || !webgpu_available) {
			soft_error('needs_webgpu', `The '${engine_name}' model needs WebGPU (GPU). `
				+ (webgpu_available
					? 'Turn off the "more compatible / CPU" option to use it.'
					: 'This browser has no WebGPU available, so this model cannot run here — try a smaller model (Opus-MT or NLLB).'));
			return;
		}
	}

	const dtype    = options.dtype || model.dtype;
	const model_id = resolve_model_id(model.model_id, source_lang_code, target_lang_code);

	// Reset cancel flag for this run
	cancelled = false;

	try {

		// ── 1. Load / reuse the model pipeline ───────────────────────────
		const signature = `${engine_name}:${model_id}:${device}:${dtype}`;
		if (cached_translator && cached_signature!==signature) {
			cached_translator = null;
			cached_signature  = null;
		}

		if (!cached_translator) {
			try {
				cached_translator = await load_pipeline(model, model_id, device, dtype);
				cached_signature  = signature;
			} catch (load_error) {

				// a model that is not in this install's store: this engine has no model for
				// the pair (the common case for opus). Soft, and the worker stays usable. (v6)
				if (is_model_not_found(load_error)) {
					soft_error('unsupported_pair', `No '${engine_name}' model is available for ${source_lang_code} → ${target_lang_code}.`);
					return;
				}

				// a model that does not fit in memory is a limit of the machine, not a crash (v6)
				if (is_allocation_failure(load_error)) {
					soft_error('model_too_large', `The '${engine_name}' model is too large to load on this device. Try a smaller model (Qwen3, NLLB or Opus-MT).`);
					return;
				}

				// A small model (no requires_webgpu) whose WebGPU initialisation failed is
				// retried on WASM/CPU, and the UI is told ('fallback_to_wasm' →
				// gpu_unavailable). Kept from the TS worker; v6 made it a fatal error. A
				// WebGPU-only model never gets here with anything but a fatal error: it cannot
				// run on WASM at all (see requires_webgpu above).
				const is_gpu_error = device==='webgpu' && !model.requires_webgpu && (
					/init|webgpu|gpu|buffer|mapping|allocation|out of memory/i.test(
						load_error?.message || load_error?.name || ''
					)
				);
				if (!is_gpu_error) {
					throw load_error;
				}
				self.postMessage({
					status : 'init',
					data   : { progress : 0, status : 'fallback_to_wasm', device : 'wasm', file : null, engine : engine_name }
				});
				cached_translator = await load_pipeline(model, model_id, 'wasm', dtype);
				cached_signature  = `${engine_name}:${model_id}:wasm:${dtype}`;
			}
		}

		// ── 2. Translate the blocks ──────────────────────────────────────
		// The loop, the repetition escalation, the repair of the markers the model lost and
		// every progress message live in block_runner.js; this worker only supplies the
		// model call, under the per-block timeout.
		await run_blocks({
			blocks       : options.blocks,
			post         : (message) => self.postMessage(message),
			is_cancelled : () => cancelled,
			translate    : (text, overrides, label) => with_timeout(
				translate_text(handler, cached_translator, text, source_lang_code, target_lang_code, overrides),
				BLOCK_TIMEOUT_MS,
				label
			)
		});

	} catch (error) {

		// Fatal error (pipeline load failed, GPU out of memory, etc.)
		self.postMessage({
			status : 'error',
			data   : {
				message : error?.message || '',
				name    : error?.name || error?.constructor?.name || '',
				stack   : error?.stack || ''
			}
		});
	}
};


/**
 * Translate a single segment with the loaded model.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DO NOT PUT INSTRUCTIONS IN `text`. TranslateGemma WILL TRANSLATE THEM.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TranslateGemma is a translation model, not a chat model: its chat template builds the
 * instruction from source_lang_code/target_lang_code, and the `text` field is the SOURCE TEXT
 * — the model card: "The text field is not meant for free-form prompts with instructions."
 * (v6 92da452aa1.) This worker used to send a whole prompt there — rules, the markers to keep,
 * worked examples with [[[n]]] tokens, and on a retry the history of failed attempts — and a
 * model translates all of it: in v6 a transcript opened with two paragraphs of the
 * instructions rendered in Nepali, and the example tokens were mapped back into REAL Dédalo
 * index marks that had never been in the source.
 *
 * So: the segment, and nothing but the segment. The Qwen shape carries its rules in a system
 * turn the model treats as instructions, never in the text.
 *
 * @param {Function} handler        - The SHAPE_HANDLERS function for this model
 * @param {Function} translator     - The loaded pipeline
 * @param {string}   text           - The segment, carrying local [[[n]]] markers
 * @param {string}   sourceLangCode - e.g. 'es'
 * @param {string}   targetLangCode - e.g. 'ne'
 * @param {Object}   overrides      - { repetition_penalty, do_sample?, temperature?, top_p? }
 * @returns {Promise<string>}
 */
async function translate_text(handler, translator, text, sourceLangCode, targetLangCode, overrides={}) {

	// generation settings are shared across shapes; only the input differs (the handler)
	const generation = {
		max_new_tokens     : max_new_tokens_for(text),
		do_sample          : overrides.do_sample===true,
		repetition_penalty : overrides.repetition_penalty
	};

	// temperature/top_p only mean something when sampling
	if (generation.do_sample) {
		generation.temperature = overrides.temperature ?? RETRY_TEMPERATURE;
		generation.top_p       = overrides.top_p ?? RETRY_TOP_P;
	}

	return handler(translator, text, sourceLangCode, targetLangCode, generation);
}


// @license-end
