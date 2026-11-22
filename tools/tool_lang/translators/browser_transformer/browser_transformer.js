// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0


/**
 * Browser Translation Worker (Web Worker)
 *
 * Runs TranslateGemma (4B-it) locally in the browser via HuggingFace Transformers
 * and ONNX runtime. Receives Markdown blocks from the main thread, translates each
 * block sequentially, and streams results back as they complete.
 *
 * Communication protocol (postMessage):
 *   Main → Worker:
 *     { options: { blocks[], sourceLangCode, targetLangCode, device } }  – start translation
 *     { cancel: true }                                                  – abort in-progress translation
 *   Worker → Main:
 *     { status: 'init',           data: { progress, status, device, file } }                       – model loading
 *     { status: 'on_chunk',       data: { accumulated_text, remaining, repair_stats } }            – progress stream
 *     { status: 'on_block_error', data: { message, block, total, accumulated_text, remaining } }  – non-fatal block error
 *     { status: 'end',            data: { accumulated_text, remaining, repair_stats } }            – done
 *     { status: 'error',          data: { message, name?, stack? } }                               – fatal error
 *     { status: 'cancelled',      data: { accumulated_text, remaining, repair_stats } }            – cancelled
 *
 * A block is { text, placeholders, restore_map } (browser_translation.js build_blocks):
 * Markdown whose Dédalo marks are [[[n]]] tokens numbered LOCALLY to the block.
 * The block loop, the corrective retries and the repair of the tokens the model lost
 * live in ../../js/block_runner.js; repair_stats names every token WE placed (in
 * document-wide numbering) so the main thread can report it. This file owns only the
 * model: loading it, and translate_text().
 *
 * HTML preservation:
 *   Source HTML is converted to markdown before being sent to the model.
 *   The prompt instructs the model to keep all markdown syntax and raw
 *   HTML tags (unsupported tags like <table>) intact.
 *   The system instruction is embedded inside the single user message
 *   (not as a separate system role) because TranslateGemma requires the
 *   conversation to start with a user turn.
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

/**
 * ONNX-optimised 4B instruction-tuned translation model.
 * Uses q4 quantisation for memory-efficient local inference.
 */

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
// rsync). The same door browser_whisper and remove_background use. Until
// P2-5-residue (2026-09-04) this worker pointed at a `./models/` directory of
// the tools tree, where 20 MB of the TranslateGemma tokenizer sat COMMITTED
// (third-party bytes under Google's terms, outside every manifest axis) and
// the multi-GB weights could not be obtained at all — the translator was a
// half-materialised feature. Model files never live in the code tree.
env.remoteHost			= new URL('/dedalo/ai_models/', self.location.origin).href;
env.remotePathTemplate	= '{model}/';
env.useBrowserCache		= true;	// a second translation must not re-download
/** The hub id, which is also the model's directory under the store. */
const MODEL_ID			= 'onnx-community/translategemma-text-4b-it-ONNX';

/**
 * Maximum tokens the model may generate per call.
 * Blocks are pre-chunked to ~1000 chars on the main thread,
 * so 1024 tokens is typically sufficient for a single block.
 */
const MAX_NEW_TOKENS	= 2048;

/**
 * Per-block timeout in milliseconds.
 * If a single block translation exceeds this duration it is treated as a failure.
 */
const BLOCK_TIMEOUT_MS	= 120_000;

/**
 * Cached pipeline instance — reused across multiple translation requests
 * without re-downloading or re-compiling the model.
 * @type {Function|null}
 */
let cached_translator = null;

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

	// Reset cancel flag for this run
	cancelled = false;

	try {

		// ── 1. Load / reuse the model pipeline ───────────────────────────
		// The pipeline is cached after the first call; subsequent calls reuse it.
		// Quantised to q4 to fit within browser memory limits (~2 GB for GPU).
		if (!cached_translator) {
			try {
				cached_translator = await pipeline('text-generation', MODEL_ID, {
					device : device,
					dtype  : 'q4',
					progress_callback: ({ progress, status, file }) => {
						// Relay download/compile progress to the UI thread
						self.postMessage({
							status : 'init',
							data   : { progress, status, device, file }
						});
					}
				});
			} catch (init_error) {
				// If WebGPU fails (OOM, buffer mapping error, etc.), auto-fallback to WASM/CPU
				const is_gpu_error = device === 'webgpu' && (
					/init|webgpu|gpu|buffer|mapping|allocation|out of memory/i.test(
						init_error?.message || init_error?.name || ''
					)
				);
				if (is_gpu_error) {
					self.postMessage({
						status : 'init',
						data   : {
							progress : 0,
							status   : 'fallback_to_wasm',
							device   : 'wasm',
							file     : null
						}
					});
					cached_translator = await pipeline('text-generation', MODEL_ID, {
						device : 'wasm',
						dtype  : 'q4',
						progress_callback: ({ progress, status, file }) => {
							self.postMessage({
								status : 'init',
								data   : { progress, status, device: 'wasm', file }
							});
						}
					});
				} else {
					throw init_error;
				}
			}
		}

		// ── 2. Translate the blocks ──────────────────────────────────────
		// The loop, the corrective retries, the repair of the markers the model lost
		// and every progress message live in block_runner.js (testable without the
		// model); this worker only supplies the model call, under the per-block timeout.
		await run_blocks({
			blocks       : options.blocks,
			post         : (message) => self.postMessage(message),
			is_cancelled : () => cancelled,
			translate    : (text, retry_context, label) => with_timeout(
				translate_text(
					cached_translator,
					text,
					source_lang_code,
					target_lang_code,
					retry_context
				),
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
 * Translate a single text block using the loaded model pipeline.
 *
 * @param {Function} translator       - The loaded HuggingFace text-generation pipeline
 * @param {string}   text             - Markdown block to translate (may contain **, *, #, raw HTML)
 * @param {string}   sourceLangCode   - Source language locale code (e.g. 'en')
 * @param {string}   targetLangCode   - Target language locale code (e.g. 'es')
 * @param {Object|null} retryContext  - When non-null, sends a corrective retry prompt
 *   built from the full history of failed attempts:
 *   { failed_attempts: Array<{ text: string, missing: string[] }> }
 * @returns {string}                  - Model response with translated text
 *
 * Implementation notes:
 *
 *   System instruction:
 *     TranslateGemma's chat template does not accept a separate 'system' role —
 *     the conversation must start with 'user'. Therefore the preservation
 *     instruction is prepended to the user text content with a blank-line
 *     separator so the model treats it as a task description.
 *
 *   Markdown preservation:
 *     The prompt tells the model to keep all markdown syntax and raw HTML tags intact.
 *     See also: tool_lang.js → html_to_markdown / markdown_to_html for the round-trip.
 *
 *   Deterministic output:
 *     `do_sample: false` disables temperature sampling, making the model
 *     behave greedily — the same input always produces the same output.
 *     This avoids random tag mutations across runs.
 */
async function translate_text(translator, text, sourceLangCode, targetLangCode, retryContext=null) {

	let prompt;

	if (retryContext) {
		// ── Retry prompt: include the full history of failed attempts ──
		const { failed_attempts } = retryContext;
		const latest_missing = failed_attempts[failed_attempts.length - 1].missing;

		const history_lines = [];
		failed_attempts.forEach((att, idx) => {
			history_lines.push(`Attempt ${idx + 1} (incorrect) — missing: ${att.missing.join(', ')}`);
			history_lines.push(att.text);
			history_lines.push(``);
		});

		prompt = [
			`Translate from ${sourceLangCode} to ${targetLangCode}.`,
			`CORRECTION REQUEST: Your previous translation(s) were incorrect.`,
			`The following placeholders are STILL MISSING from your output: ${latest_missing.join(', ')}`,
			`You MUST include every single one of them EXACTLY as shown.`,
			``,
			`Your previous (incorrect) translation attempts:`,
			...history_lines,
			`RULES:`,
			`1. The text is in MARKDOWN format. Keep all markdown syntax (**, *, #, __, etc.) unchanged.`,
			`2. Keep ALL placeholders like [[[18]]], [[[1]]], [[[5]]], [[[424]]], etc. EXACTLY as-is — never modify, translate, or remove them.`,
			`3. The missing placeholders ${latest_missing.join(', ')} MUST appear in your output.`,
			`4. Preserve any raw HTML tags (e.g. <img>, <span>) exactly as they appear.`,
			`5. Do not add or remove blank lines.`,
			`6. Verify every placeholder [[[…]]] from the input appears IDENTICALLY in your output.`,
			``,
			`Text to translate:`,
			text
		].join('\n');
	} else {
		// ── First-attempt prompt ──────────────────────────────────────────
		prompt = [
			`Translate from ${sourceLangCode} to ${targetLangCode}.`,
			`RULES:`,
			`1. The text is in MARKDOWN format. Keep all markdown syntax (**, *, #, __, etc.) unchanged.`,
			`2. Keep all placeholders like [[[18]]], [[[1]]], [[[5]]], [[[424]]], etc. EXACTLY as-is — never modify, translate, or remove them.`,
			`3. Preserve any raw HTML tags (e.g. <img>, <span>) exactly as they appear.`,
			`4. Do not add or remove blank lines.`,
			`5. Ensure the translated text was done with the target language: ${targetLangCode}`,
			`6. Verify every placeholder [[[…]]] from the input appears IDENTICALLY in your output.`,
			``,
			`Examples:`,
			`Input:  "**Hola[[[5]]]** ¿como estás[[[2]]][[[3]]]?"`,
			`Correct output: "**Hello[[[5]]]** how are you[[[2]]][[[3]]]?"`,
			`Wrong output: "Hello[[[9]]] how are you[[[2]]]?"`,
			``,
			`Input:  "[[[1]]][[[2]]]Gracias por tu[[[3]]] \"tiempo[[[18]]]\"[[[4]]].[[[68]]][[[108]]]"`,
			`Correct output: "[[[1]]][[[2]]]Thank for your[[[3]]] \"time[[[18]]]\"[[[4]]].[[[68]]][[[108]]]"`,
			`Wrong output: "[[[1]]]Thank for your[[[2]]][[[3]]] \"time[[18 ]]\".[ [68]]"`,
			``,
			`Input: "Hello[[[1]]], welcome!"`,
			`Correct output: "Hola[[[1]]], ¡bienvenido!"`,
			`Wrong output: "Hola, ¡bienvenido!"`,
			``,
			`Input: "[[[1]]]Hello, [[[2]]]welcome! new [[[8]]]eeerew[[[35]]]"`,
			`Correct output: "[[[1]]]Hola, [[[2]]]¡bienvenido! nuevo [[[8]]]eeerew[[[35]]]"`,
			`Wrong output: "Hola, [[[2]]]¡bienvenido! nuevo texto"`,
			``,
			`Input: "[[[36]]] Hola [[[37]]] [[[105]]]¿como estás? [[[52]]]"`,
			`Correct output: "[[[36]]] नमस्ते [[[37]]] [[[105]]]तिमीलाई कस्तो छ? [[[52]]]"`,
			`Wrong output: "[[[36]] नमस्ते [37]]] [[[105तिमीलाई कस्तो छ? 52]]]"`,
			``,
			`Text to translate:`,
			text
		].join('\n');
	}

	// const prompt = [
	// 	`Translate the following text into **[${targetLangCode}]**.`,
	// 	'**CRITICAL CONSTRAINTS:**',
	// 	'1. The text contains placeholders in the format `[[[1]]]`, `[[[88]]]`, etc. These are non-translatable constants.',
	// 	'2. **DO NOT** translate, modify, or remove the placeholders.',
	// 	'3. **DO NOT** change the numbers inside the placeholders.',
	// 	'5. **Output ONLY** the translated text without any explanations or introductory remarks.',
	// 	'6. Keep all HTML tags unchanged.',

	// 	`**Text to translate:**`,
	// 	`${text}`
	// ].join('\n');

	const messages = [
		{
			role    : 'user',
			content : [
				{
					type             : 'text',
					source_lang_code : sourceLangCode,
					target_lang_code : targetLangCode,
					text             : prompt
				}
			]
		}
	];

	const output = await translator(messages, {
		max_new_tokens : MAX_NEW_TOKENS,
		do_sample      : false
	});

	// The model returns the full conversation so far;
	// grab the assistant's last (newly generated) message.
	const generated_text = output[0].generated_text;
	const last_message   = generated_text[generated_text.length - 1];

	return last_message.content;
}


// @license-end