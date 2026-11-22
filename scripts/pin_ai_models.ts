/**
 * PIN THE AI MODELS — THE documented procedure for `src/core/ai/model_pins.json`.
 *
 * A model artifact is fetched by IMMUTABLE hub revision and verified by sha256
 * before the store records it (P1-25 / CARRY-06). Those digests come from here,
 * and from nowhere else — a hand-edited digest is a contract edit with no
 * evidence behind it, and leg (g) of `model_artifact_integrity_native` refuses
 * an entry without `pinned_at` and a `reason`.
 *
 * Usage (needs the network ONCE; never touches the model store; never
 * downloads a weight — only the small non-LFS files are fetched, to hash):
 *   bun run scripts/pin_ai_models.ts --model <id> --reason "<why this pin changes>"
 *   bun run scripts/pin_ai_models.ts --all [--tool tool_lang] --reason "<why>"
 *   bun run scripts/pin_ai_models.ts --expand [--pair-langs en,es,…] --reason "<why>"
 *   bun run scripts/pin_ai_models.ts (--all | --model <id>) --licence-only --reason "<why>"
 *   bun run scripts/pin_ai_models.ts --check          # every catalog model has a pin covering every wanted file, and a licence record
 *
 * The catalogue is BOTH tools' in-browser models (scripts/lib/ai_model_register.ts):
 * tool_transcription's ASR + speaker pair and tool_lang's translators. A
 * one-model-per-pair translator (`Xenova/opus-mt-{src}-{tgt}`) is EXPANDED
 * first: `--expand` probes every ordered pair of the candidate languages
 * (`--pair-langs`, else the ones recorded last time) against the revision API
 * and records the ids that exist in `model_pins.json` `expansions` — a pair the
 * hub does not serve is not part of the catalogue. `--all` then pins them.
 *
 * What it does per model:
 *   1. `GET <hub>/api/models/<id>/revision/main` → the commit sha (immutable);
 *   2. `GET <hub>/api/models/<id>/tree/<sha>?recursive=true` → for every LFS
 *      weight, `lfs.oid` IS its sha256 and `lfs.size` its length (no gigabyte
 *      download); the small non-LFS files (config, tokenizer) carry only a git
 *      blob id, so they are downloaded at the pinned revision and hashed here;
 *   3. cross-check: the tree's size must equal the hashed file's size;
 *   4. the WEIGHT set is the engine's (`modelFilesForConfig`) for the model's
 *      REAL `config.json` at that revision — each weight's external-data chunks
 *      are a fact of that config — and, for a translator, it must equal what the
 *      VENDORED transformers.js runtime itself names for that config + dtype
 *      (`ModelRegistry.get_model_files`, offline): a disagreement throws, so a
 *      kind mapped to the wrong session shape cannot be pinned;
 *   5. the LICENCE record (`ModelLicence` in model_pins.ts): the card's
 *      `license` at the pinned revision, its `base_model`'s card licence, and
 *      which of the two governs;
 *   6. rewrite the model's block with `revision`, `pinned_at` (today), the
 *      `reason`, the licence and every wanted file that exists at that revision.
 *      A wanted file the repository does not publish is left OUT (the
 *      downloader skips an OPTIONAL file with no pin and refuses a REQUIRED one).
 *
 * A model the hub does not serve at all (404 on the revision API) is recorded
 * in the `unpinned` block with the reason, so the gate can enumerate it
 * shrink-only instead of a digest being invented for it.
 *
 * `--hub <base>` exists for the gate (a loopback fixture hub); production runs
 * use the engine's own `HUB_BASE`. Every request is a plain anonymous GET to the
 * hub's public API: no token, no identifying header.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HUB_BASE } from '../src/core/ai/model_fetch.ts';
import { SHA256_HEX } from '../src/core/ai/model_integrity.ts';
import {
	type FilePin,
	licenceProblems,
	MODEL_PINS_PATH,
	type ModelLicence,
	type ModelPin,
	type PinTable,
	parsePinTable,
	REVISION_HEX,
	type TemplateExpansion,
} from '../src/core/ai/model_pins.ts';
import { type ModelKind, modelFilesForConfig } from '../src/core/ai/model_store.ts';
import {
	commonFilesFor,
	expandTemplate,
	filesFor,
	type RegisterCatalogModel,
	readRegisterCatalog,
	readTranslationTemplates,
} from './lib/ai_model_register.ts';

interface TreeEntry {
	type: 'file' | 'directory';
	path: string;
	size: number;
	lfs?: { oid: string; size: number };
}

/** The slice of a hub model card the licence record reads. */
interface CardData {
	license?: unknown;
	license_name?: unknown;
	license_link?: unknown;
	base_model?: unknown;
}

/** The hub's answer for one model at its immutable revision. */
export interface HubPinSource {
	revision: string;
	tree: Map<string, TreeEntry>;
	/** The model card's metadata at that revision (empty when the repo has no card). */
	card: CardData;
}

/**
 * Conversions whose model card is SILENT on what they were converted from —
 * the base each one's repository name reproduces, with the evidence. Consulted
 * ONLY when the card names no `base_model`; a card that names one wins. Every
 * entry is a human-checked claim (2026-11-22), never inferred by code.
 */
const UPSTREAM_WHEN_CARD_SILENT: Readonly<Record<string, string>> = {
	// No README at all; repo name = upstream name + "-ONNX"; config.json
	// architecture Qwen3ForCausalLM.
	'onnx-community/Qwen3-4B-Instruct-2507-ONNX': 'Qwen/Qwen3-4B-Instruct-2507',
	// No README; the repo also carries the upstream's model.safetensors; config
	// architecture Gemma3ForCausalLM (the text tower of google/translategemma-4b-it).
	'onnx-community/translategemma-text-4b-it-ONNX': 'google/translategemma-4b-it',
	// Card names no base_model; repo name = upstream name + "-ONNX" (the sibling
	// whisper-base/large-v3 conversions name openai/* explicitly).
	'onnx-community/whisper-medium-ONNX': 'openai/whisper-medium',
};

async function hubJson(url: string): Promise<unknown | null> {
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
	if (response.status === 404 || response.status === 401) return null;
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return response.json();
}

/**
 * Revision + recursive tree + card, or null when the hub has no such model.
 * `at` defaults to `main` (a new pin); an existing pin's sha reads the card as
 * it was AT that revision (`--licence-only`).
 */
export async function readHubSource(
	hubBase: string,
	modelId: string,
	at = 'main',
): Promise<HubPinSource | null> {
	const revision = (await hubJson(`${hubBase}/api/models/${modelId}/revision/${at}`)) as {
		sha?: string;
		cardData?: CardData;
	} | null;
	if (revision === null || typeof revision.sha !== 'string' || !REVISION_HEX.test(revision.sha)) {
		return null;
	}
	const tree = (await hubJson(
		`${hubBase}/api/models/${modelId}/tree/${revision.sha}?recursive=true`,
	)) as TreeEntry[] | null;
	if (!Array.isArray(tree))
		throw new Error(`${modelId}: the hub tree at ${revision.sha} is not a list`);
	return {
		revision: revision.sha,
		tree: new Map(tree.map((entry) => [entry.path, entry])),
		card: revision.cardData ?? {},
	};
}

/** Download one small file at the pinned revision (config/tokenizer — never a weight). */
async function fetchSmallFile(
	hubBase: string,
	modelId: string,
	revision: string,
	file: string,
): Promise<Uint8Array> {
	const url = `${hubBase}/${modelId}/resolve/${revision}/${file}`;
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/** Download one small file at the pinned revision and hash it. */
async function hashRemoteFile(
	hubBase: string,
	modelId: string,
	revision: string,
	file: string,
): Promise<{ sha256: string; size: number }> {
	const bytes = await fetchSmallFile(hubBase, modelId, revision, file);
	return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}

/**
 * The pin of one wanted file: `lfs.oid` for a weight (cross-checked against the
 * tree size), a download-and-hash for a plain blob. Null when the repository
 * does not publish the file at this revision.
 */
export async function pinOneFile(
	hubBase: string,
	modelId: string,
	source: HubPinSource,
	file: string,
): Promise<FilePin | null> {
	const entry = source.tree.get(file);
	if (entry === undefined || entry.type !== 'file') return null;
	if (entry.lfs !== undefined) {
		if (!SHA256_HEX.test(entry.lfs.oid))
			throw new Error(`${modelId}/${file}: lfs.oid is not a sha256`);
		if (entry.lfs.size !== entry.size) {
			throw new Error(`${modelId}/${file}: tree size ${entry.size} != lfs size ${entry.lfs.size}`);
		}
		return { sha256: entry.lfs.oid, size: entry.lfs.size };
	}
	// A non-LFS blob is small by construction (the hub stores anything large in
	// LFS); refuse to download one that is not, so this can never fetch weights.
	if (entry.size > SMALL_FILE_CEILING) {
		throw new Error(
			`${modelId}/${file}: a ${entry.size}-byte non-LFS blob — refusing to download it`,
		);
	}
	const hashed = await hashRemoteFile(hubBase, modelId, source.revision, file);
	if (hashed.size !== entry.size) {
		throw new Error(
			`${modelId}/${file}: downloaded ${hashed.size} bytes, the tree says ${entry.size}`,
		);
	}
	return hashed;
}

/** The largest non-LFS file the procedure downloads (tokenizers run to ~20 MB). */
const SMALL_FILE_CEILING = 64 * 1024 * 1024;

/** The model's config.json at the pinned revision (null when the repo has none). */
async function readConfig(
	hubBase: string,
	model: RegisterCatalogModel,
	source: HubPinSource,
): Promise<unknown> {
	if (source.tree.get('config.json')?.type !== 'file') return null;
	const bytes = await fetchSmallFile(hubBase, model.id, source.revision, 'config.json');
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** The kinds whose file set is held to the vendored runtime at pin time. */
const RUNTIME_CHECKED_KINDS: ReadonlySet<ModelKind> = new Set(['decoder_only', 'seq2seq']);

/** The vendored transformers.js bundle — the runtime the browser actually runs. */
const VENDORED_RUNTIME = resolve(
	import.meta.dir,
	'..',
	'vendor',
	'transformers',
	'dist',
	'transformers.js',
);

/**
 * What the VENDORED runtime names for this config + dtype — offline (the config
 * is passed in, so nothing is fetched): config, weights + chunks, and the
 * optional generation config.
 */
export async function runtimeModelFiles(
	modelId: string,
	config: unknown,
	dtype: unknown,
): Promise<string[]> {
	const runtime = (await import(VENDORED_RUNTIME)) as {
		ModelRegistry: {
			get_model_files: (id: string, options: Record<string, unknown>) => Promise<string[]>;
		};
	};
	return runtime.ModelRegistry.get_model_files(modelId, { config, dtype });
}

/**
 * The engine's weight set for this model and config, HELD to the runtime for a
 * translator kind: the two sets (plus the runtime's optional generation config)
 * must be equal, or the pin is refused.
 */
async function weightFiles(model: RegisterCatalogModel, config: unknown): Promise<string[]> {
	const kind: ModelKind = model.kind ?? 'asr';
	const engine = modelFilesForConfig(model.dtype, kind, config);
	if (!RUNTIME_CHECKED_KINDS.has(kind)) return engine;
	const runtime = await runtimeModelFiles(model.id, config, model.dtype);
	const expected = [...engine, 'generation_config.json'].sort();
	const actual = [...new Set(runtime)].sort();
	if (JSON.stringify(expected) !== JSON.stringify(actual)) {
		throw new Error(
			`${model.id}: the engine's ${kind} file set ${JSON.stringify(expected)} is not the vendored runtime's ${JSON.stringify(actual)}`,
		);
	}
	return engine;
}

/** A card's `license` as a name: `other` + `license_name` reads as the name. */
function cardLicence(card: CardData): string | null {
	const license = typeof card.license === 'string' ? card.license : null;
	if (license === 'other' && typeof card.license_name === 'string') return card.license_name;
	return license;
}

/** Where a card's licence is to be read: its `license_link`, else the card page. */
function cardLicenceUrl(modelId: string, card: CardData): string {
	const link = typeof card.license_link === 'string' ? card.license_link.trim() : '';
	if (link.startsWith('https://')) return link;
	if (link !== '') return `${HUB_BASE}/${modelId}/blob/main/${link.replace(/^\.?\//, '')}`;
	return `${HUB_BASE}/${modelId}`;
}

/** The card's declared base model (first, when it lists several). */
function cardBase(card: CardData): string | null {
	const base = Array.isArray(card.base_model) ? card.base_model[0] : card.base_model;
	return typeof base === 'string' && base.trim() !== '' ? base.trim() : null;
}

/**
 * The licence record of one model (see `ModelLicence`): its own card, its
 * base model's card, and which governs. URLs always name the PUBLIC hub page
 * (`HUB_BASE`), whatever hub answered — the record is evidence for a human.
 */
export async function readLicence(
	hubBase: string,
	modelId: string,
	card: CardData,
): Promise<ModelLicence> {
	const own = cardLicence(card);
	const declaredBase = cardBase(card);
	const baseId = declaredBase ?? UPSTREAM_WHEN_CARD_SILENT[modelId] ?? null;
	let upstream: ModelLicence['upstream'] = null;
	if (baseId !== null) {
		const base = (await hubJson(`${hubBase}/api/models/${baseId}`)) as {
			cardData?: CardData;
		} | null;
		if (base === null) throw new Error(`${modelId}: its base model ${baseId} is not on the hub`);
		const baseCard = base.cardData ?? {};
		upstream = {
			model: baseId,
			license: cardLicence(baseCard),
			url: cardLicenceUrl(baseId, baseCard),
			named_by: declaredBase !== null ? 'card' : 'repo_name',
		};
	}
	const cardRecord = { license: own, url: cardLicenceUrl(modelId, card) };
	if (own !== null) {
		return { name: own, url: cardRecord.url, declared_by: 'card', card: cardRecord, upstream };
	}
	if (upstream === null || upstream.license === null) {
		throw new Error(
			`${modelId}: neither its card nor an upstream declares a licence — not pinnable until one does (a hand-typed licence is not a record)`,
		);
	}
	return {
		name: upstream.license,
		url: upstream.url,
		declared_by: 'upstream',
		card: cardRecord,
		upstream,
	};
}

/** Pin one catalog model against the hub; null when the hub does not serve it. */
export async function pinModel(
	hubBase: string,
	model: RegisterCatalogModel,
	reason: string,
	today: string,
): Promise<ModelPin | null> {
	const source = await readHubSource(hubBase, model.id);
	if (source === null) return null;
	const config = await readConfig(hubBase, model, source);
	const kind: ModelKind = model.kind ?? 'asr';
	const wanted = [
		...new Set([...commonFilesFor(kind).common, ...(await weightFiles(model, config))]),
	];
	const files: Record<string, FilePin> = {};
	for (const file of wanted) {
		const pin = await pinOneFile(hubBase, model.id, source, file);
		if (pin !== null) files[file] = pin;
	}
	const licence = await readLicence(hubBase, model.id, source.card);
	return { revision: source.revision, pinned_at: today, reason, licence, files };
}

/**
 * Expand one templated id over every ordered pair of `langs`: probe each id's
 * revision API (404/401 = not served, anything else non-OK throws) and record
 * the ones that exist.
 */
export async function expandPairs(
	hubBase: string,
	template: string,
	langs: readonly string[],
	reason: string,
	today: string,
): Promise<TemplateExpansion> {
	const candidates: string[] = [];
	for (const src of langs) {
		for (const tgt of langs) if (src !== tgt) candidates.push(expandTemplate(template, src, tgt));
	}
	const present: string[] = [];
	for (const id of candidates) {
		const revision = (await hubJson(`${hubBase}/api/models/${id}/revision/main`)) as {
			sha?: string;
		} | null;
		if (revision !== null && typeof revision.sha === 'string') present.push(id);
	}
	return { langs: [...langs], computed_at: today, reason, probed: candidates.length, present };
}

function readTable(path: string): PinTable {
	if (!existsSync(path)) return { models: {}, unpinned: {}, expansions: {} };
	return parsePinTable(readFileSync(path, 'utf8'));
}

/** Sorted-key, tab-indented JSON so a diff of the pin file reads as one entry. */
function serialize(table: PinTable): string {
	const sortKeys = <T extends Record<string, unknown>>(record: T): T =>
		Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, record[key]]),
		) as T;
	return `${JSON.stringify(
		{
			models: sortKeys(table.models),
			unpinned: sortKeys(table.unpinned),
			expansions: sortKeys(table.expansions ?? {}),
		},
		null,
		'\t',
	)}\n`;
}

/** The pin problems of the current table against the catalog (empty = fine). */
export function checkTable(
	table: PinTable,
	catalog: RegisterCatalogModel[],
	templates: RegisterCatalogModel[] = readTranslationTemplates(),
): string[] {
	const problems: string[] = [];
	for (const template of templates) {
		if (table.expansions?.[template.id] === undefined) {
			problems.push(
				`${template.id}: a templated catalog id with no recorded expansion (run --expand)`,
			);
		}
	}
	for (const model of catalog) {
		const pin = table.models[model.id];
		if (pin === undefined) {
			if (table.unpinned[model.id] === undefined)
				problems.push(`${model.id}: no pin and not in unpinned`);
			continue;
		}
		problems.push(...licenceProblems(model.id, pin));
		const { optional } = commonFilesFor(model.kind ?? 'asr');
		for (const file of filesFor(model, table)) {
			// An OPTIONAL file the repository does not publish has no pin, honestly.
			if (pin.files[file] === undefined && !optional.includes(file)) {
				problems.push(`${model.id}: ${file} has no pin`);
			}
		}
	}
	return problems;
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const USAGE = `usage: bun run scripts/pin_ai_models.ts (--model <id> | --all [--tool tool_lang|tool_transcription]) [--licence-only] --reason "<why>" [--hub <base>] [--pins <file>]
       bun run scripts/pin_ai_models.ts --expand [--pair-langs en,es,…] --reason "<why>"
       bun run scripts/pin_ai_models.ts --check`;

/** `--expand`: (re)compute every templated id's expansion. */
async function runExpand(
	table: PinTable,
	hubBase: string,
	reason: string,
	today: string,
): Promise<void> {
	const flag = arg('--pair-langs');
	for (const template of readTranslationTemplates()) {
		const langs =
			flag !== undefined
				? flag
						.split(',')
						.map((lang) => lang.trim())
						.filter((lang) => lang !== '')
				: (table.expansions?.[template.id]?.langs ?? []);
		if (langs.length < 2) {
			console.error(`${template.id}: no candidate languages (pass --pair-langs)`);
			process.exit(1);
		}
		const expansion = await expandPairs(hubBase, template.id, langs, reason, today);
		table.expansions = { ...(table.expansions ?? {}), [template.id]: expansion };
		console.log(`${template.id}: ${expansion.present.length} of ${expansion.probed} pairs served`);
	}
}

/** Pin (or, with --licence-only, re-read the licence of) the wanted models. */
async function runPin(
	table: PinTable,
	catalog: RegisterCatalogModel[],
	wanted: string[],
	hubBase: string,
	reason: string,
	today: string,
): Promise<void> {
	const licenceOnly = process.argv.includes('--licence-only');
	for (const modelId of wanted) {
		const model = catalog.find((entry) => entry.id === modelId);
		if (model === undefined) {
			console.error(
				`${modelId}: not in the catalog (tools/tool_transcription or tools/tool_lang register.json)`,
			);
			process.exit(1);
		}
		process.stdout.write(`${modelId} … `);
		const existing = table.models[modelId];
		if (licenceOnly) {
			if (existing === undefined) {
				console.log('not pinned — skipped');
				continue;
			}
			// The card AS IT WAS at the pinned revision — the bytes' own terms.
			const source = await readHubSource(hubBase, modelId, existing.revision);
			if (source === null || source.revision !== existing.revision) {
				throw new Error(
					`${modelId}: the hub no longer answers the pinned revision ${existing.revision}`,
				);
			}
			existing.licence = await readLicence(hubBase, modelId, source.card);
			console.log(`licence ${existing.licence.name} (${existing.licence.declared_by})`);
			continue;
		}
		const pin = await pinModel(hubBase, model, reason, today);
		if (pin === null) {
			table.unpinned[modelId] = {
				reason: `the hub has no repository at this id (revision API answered 404/401 on ${today}); ${reason}`,
			};
			delete table.models[modelId];
			console.log('NOT SERVED by the hub — recorded as unpinned');
			continue;
		}
		delete table.unpinned[modelId];
		table.models[modelId] = pin;
		const missing = filesFor(model, table).filter((file) => pin.files[file] === undefined);
		console.log(
			`${pin.revision.slice(0, 12)} (${Object.keys(pin.files).length} files, licence ${pin.licence?.name}${missing.length > 0 ? `, not published: ${missing.join(', ')}` : ''})`,
		);
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const pinsPath = arg('--pins') ?? MODEL_PINS_PATH;
	const hubBase = arg('--hub') ?? HUB_BASE;
	const table = readTable(pinsPath);

	if (argv.includes('--check')) {
		const problems = checkTable(table, readRegisterCatalog(undefined, undefined, table));
		for (const problem of problems) console.error(`  ✗ ${problem}`);
		console.log(
			problems.length === 0 ? 'every catalog model is pinned' : `${problems.length} problem(s)`,
		);
		process.exit(problems.length === 0 ? 0 : 1);
	}

	const reason = (arg('--reason') ?? '').trim();
	const today = new Date().toISOString().slice(0, 10);
	if (reason.length < 12) {
		console.log(USAGE);
		process.exit(1);
	}
	if (argv.includes('--expand')) {
		await runExpand(table, hubBase, reason, today);
	} else {
		const catalog = readRegisterCatalog(undefined, undefined, table);
		// `--tool` narrows `--all` to one catalogue, so pinning the translators never
		// moves a transcription pin (and vice versa).
		const tool = arg('--tool');
		const wanted = argv.includes('--all')
			? catalog
					.filter((model) => tool === undefined || model.tool === tool)
					.map((model) => model.id)
			: [arg('--model') ?? ''];
		if (wanted[0] === '') {
			console.log(USAGE);
			process.exit(1);
		}
		await runPin(table, catalog, wanted, hubBase, reason, today);
	}
	writeFileSync(pinsPath, serialize(table));
	console.log(`wrote ${pinsPath}`);
}
