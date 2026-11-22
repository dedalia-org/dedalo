/**
 * SEED THE LOCAL AI MODEL STORE.
 *
 * Downloads the in-browser models (speech recognition and speaker detection for
 * tool_transcription; the translators of tool_lang's local AI engine, one
 * opus-mt model per language pair) into the install's own store, so the browser never talks to a public model hub. This is
 * an OPERATOR action, run once per model on a machine that has internet — an
 * air-gapped archive seeds its store by copying the directory in with rsync
 * instead, which is exactly why the store is a plain folder of plain files.
 *
 * Usage:
 *   bun run scripts/fetch_ai_models.ts --list
 *   bun run scripts/fetch_ai_models.ts onnx-community/whisper-large-v3-turbo
 *   bun run scripts/fetch_ai_models.ts --all
 *   bun run scripts/fetch_ai_models.ts <model> --store /data/dedalo/ai_models
 *
 * The store location comes from DEDALO_AI_MODEL_STORE (default
 * <private>/ai_models) unless --store overrides it. Existing files are kept:
 * re-running is a cheap way to complete an interrupted download.
 *
 * A large speech model is ~1.5 GB; a decoder-only translator (Qwen3 4B,
 * TranslateGemma 4B) ~3 GB; an opus-mt pair ~115 MB. Nothing here runs at install time or at
 * request time; an install with an empty store simply has no local models, which
 * the tool reports plainly rather than silently reaching for the internet.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { downloadModel } from '../src/core/ai/model_fetch.ts';
import { pinnedRevision } from '../src/core/ai/model_pins.ts';
import { modelStoreRoot } from '../src/core/ai/model_store.ts';
import { commonFilesFor, filesFor, readRegisterCatalog } from './lib/ai_model_register.ts';

/**
 * THE catalog — read from the tool's own `register.json` through
 * `scripts/lib/ai_model_register.ts`, never restated here. The picker in the
 * browser, this seeder, the pin generator and the integrity gate must all see
 * the same models with the same quantisation; a second list is how they drift.
 */
const readCatalog = readRegisterCatalog;

function usage(): void {
	console.log(`Seed the local AI model store.

  bun run scripts/fetch_ai_models.ts --list
  bun run scripts/fetch_ai_models.ts <model-id> [--store <dir>]
  bun run scripts/fetch_ai_models.ts --all [--store <dir>]

Every model is fetched at the immutable hub revision pinned in
src/core/ai/model_pins.json and verified by sha256 before it counts as
installed; a model without a pin is refused (pin it first:
bun run scripts/pin_ai_models.ts --model <id> --reason "<why>").
`);
}

function listCatalog(): void {
	const store = modelStoreRoot();
	console.log(`store: ${store}${existsSync(store) ? '' : '  (does not exist yet)'}\n`);
	for (const model of readCatalog()) {
		// Present means USABLE: every file the catalog's dtype asks for is there.
		const { optional } = commonFilesFor(model.kind ?? 'asr');
		const present = filesFor(model).every(
			(file) =>
				optional.includes(file) ||
				(existsSync(join(store, model.id, file)) && statSync(join(store, model.id, file)).size > 0),
		);
		const pinned = pinnedRevision(model.id) !== null ? '' : '  [NO PIN — cannot be fetched]';
		console.log(
			`  ${present ? '✓' : ' '} ${model.id}${pinned}\n      [${model.tool ?? 'tool_transcription'}] ${model.label}${model.note !== '' ? ` — ${model.note}` : ''}`,
		);
	}
	console.log('\n✓ = ready to use (all files the catalog asks for are present)');
}

async function fetchModel(modelId: string, store: string): Promise<void> {
	console.log(`\n${modelId} → ${join(store, modelId)}`);

	const catalog = readCatalog();
	const model = catalog.find((entry) => entry.id === modelId);
	if (model === undefined) {
		// A model outside the catalog has no pin, and a download the engine cannot
		// verify is one it does not make — downloadModel would refuse it anyway;
		// saying so here names the remedy.
		throw new Error(
			`${modelId} is in no in-browser model catalog and has no pin — add it to tools/tool_transcription/register.json or tools/tool_lang/register.json and pin it with scripts/pin_ai_models.ts`,
		);
	}

	// The SAME downloader the admin UI action uses (src/core/ai/model_fetch.ts) —
	// two download paths would drift on the file list or the quantisation.
	const report = await downloadModel(model.id, model.dtype, {
		store,
		quiet: false,
		onFile: (file) => console.log(`  ↓ ${file}`),
		// The kind decides the file set (commonFilesFor is the downloader's default).
		kind: model.kind ?? 'asr',
	});
	for (const file of report.skipped) console.log(`  - ${file} (not published for this model)`);
	if (!report.ok) {
		throw new Error(report.errors.join('\n'));
	}
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
	usage();
	process.exit(0);
}

const storeFlag = args.indexOf('--store');
const store = storeFlag !== -1 ? (args[storeFlag + 1] ?? modelStoreRoot()) : modelStoreRoot();
const requested = args.filter((arg, index) => {
	if (arg.startsWith('--')) return false;
	if (storeFlag !== -1 && index === storeFlag + 1) return false;
	return true;
});

if (args.includes('--list')) {
	listCatalog();
	process.exit(0);
}

const models = args.includes('--all') ? readCatalog().map((model) => model.id) : requested;
if (models.length === 0) {
	usage();
	process.exit(1);
}

for (const modelId of models) {
	await fetchModel(modelId, store);
}
console.log(`\nDone. Store: ${store}`);
