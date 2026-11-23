// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * BROWSER_MODELS
 * The in-browser translation model catalogue — the ONE code copy of the
 * register.json catalogue (misc.dd999 / misc.dd1633 → translator_engine →
 * browser_transformer.models). Ported from v6 (40bf5eaacf + 23010156ad).
 *
 * register.json is the source of truth and reaches the client on the engine definition;
 * this copy is only the fallback for an installation whose STORED tool config predates the
 * `models` array (v6 kept the same fallback twice — FALLBACK_MODELS in render_tool_lang and
 * DEFAULT_MODELS in the worker; here only the selector reads it, through offered_models —
 * the worker runs the definition it is sent and never resolves a model by name, so a model
 * that is not offered cannot be reached through it). The unit gate
 * test/unit/tool_lang_placeholder_repair.test.ts asserts it equals both register.json copies.
 *
 * A model definition:
 *   name               — key; its label is the engine_<name> tool label
 *   model_id           — hub id = its directory in this install's model store
 *                        ({src}/{tgt} filled per pair for opus, one model per pair)
 *   task               — transformers.js pipeline task
 *   shape              — how the worker feeds it (browser_transformer.js SHAPE_HANDLERS)
 *   dtype              — quantisation it is pinned and served at
 *   dtypes             — optional: every quantisation it is pinned at, when more than one
 *                        (the Quality selector offers them; none declares it yet)
 *   requires_webgpu    — a multi-GB model cannot run on the WASM/CPU backend
 *   note               — licence / size note (v6)
 *   langs              — 'all' | 'pairs' | string[] (browser_transformer.js supports_langs)
 *   offered_by_default — false: listed, NOT offered in the model selector unless the
 *                        installation's tool config sets it to true (owner ruling Q1,
 *                        2026-11-22: a model whose licence forbids use or redistribution
 *                        here is still catalogued, not offered by default)
 *   not_offered_reason — why, when offered_by_default is false
 *
 * Exports: BROWSER_MODELS, offered_models, is_offered
 */

/**
 * @typedef {Object} BrowserModel
 * @property {string} name
 * @property {string} model_id
 * @property {string} task
 * @property {string} shape
 * @property {string} dtype
 * @property {string[]} [dtypes]
 * @property {boolean} requires_webgpu
 * @property {string} [note]
 * @property {'all'|'pairs'|string[]} langs
 * @property {boolean} offered_by_default
 * @property {string} [not_offered_reason]
 */

/** @type {ReadonlyArray<BrowserModel>} */
export const BROWSER_MODELS = Object.freeze([
	{
		name: 'qwen',
		model_id: 'onnx-community/Qwen3-4B-Instruct-2507-ONNX',
		task: 'text-generation',
		shape: 'chat',
		dtype: 'q4f16',
		requires_webgpu: true,
		note: 'apache',
		langs: 'all',
		offered_by_default: true,
	},
	{
		name: 'translategemma',
		model_id: 'onnx-community/translategemma-text-4b-it-ONNX',
		task: 'text-generation',
		shape: 'chat_gemma',
		dtype: 'q4',
		requires_webgpu: true,
		langs: 'all',
		offered_by_default: true,
	},
	{
		name: 'nllb',
		model_id: 'Xenova/nllb-200-distilled-600M',
		task: 'translation',
		shape: 'seq2seq_lang',
		dtype: 'q8',
		requires_webgpu: false,
		note: 'non_commercial',
		langs: 'all',
		offered_by_default: false,
		not_offered_reason:
			'CC-BY-NC-4.0: licensed for non-commercial purposes only (§2(a)(1)); an installation run for commercial advantage may not use it. Enable it in the tool config only after confirming the use is non-commercial.',
	},
	{
		name: 'madlad',
		model_id: 'Kutalia/madlad400-3b-mt-onnx',
		task: 'text2text-generation',
		shape: 'seq2seq_prefix',
		dtype: 'q8',
		requires_webgpu: true,
		note: 'large_download',
		langs: 'all',
		offered_by_default: true,
	},
	{
		name: 'opus',
		model_id: 'Xenova/opus-mt-{src}-{tgt}',
		task: 'translation',
		shape: 'seq2seq_pair',
		dtype: 'q8',
		requires_webgpu: false,
		langs: 'pairs',
		offered_by_default: true,
	},
]);

/**
 * OFFERED_MODELS
 * The models a selector offers: the configured catalogue (or this fallback when the stored
 * config has none), minus every model that is not offered (is_offered: a strict boolean).
 * @param {ReadonlyArray<BrowserModel>|null|undefined} configured - browser_transformer.models from the tool config
 * @returns {Array<BrowserModel>}
 */
export const offered_models = (configured) => {
	const catalogue = Array.isArray(configured) && configured.length > 0 ? configured : BROWSER_MODELS;
	return catalogue.filter((model) => is_offered(model));
}; //end offered_models

/**
 * IS_OFFERED
 * offered_by_default is a STRICT boolean (A1-02 re-review): absent → offered (the
 * documented default), true → offered, false or ANY other value (the string 'false', 0,
 * null) → not offered. A hand-edited config never offers a model by a truthy accident. No
 * model (null / undefined — a hole in a hand-edited list) is never offered.
 * @param {BrowserModel|null|undefined} model
 * @returns {boolean}
 */
export const is_offered = (model) =>
	model != null && (model.offered_by_default === undefined || model.offered_by_default === true); //end is_offered

// @license-end
