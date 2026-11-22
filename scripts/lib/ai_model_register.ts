/**
 * THE IN-BROWSER MODEL CATALOGUES AS THE REPO SHIPS THEM — read from the tools'
 * own `register.json` files, never restated.
 *
 * Two catalogues, one list:
 *   - TRANSCRIPTION — `tools/tool_transcription/register.json`: the speaker-
 *     detection pair (`kind: 'diarization'`) and the ASR quality list;
 *   - TRANSLATION — `tools/tool_lang/register.json`
 *     (`translator_engine` → the `browser_transformer` engine's `models`, the
 *     v6 multi-model catalogue ported 2026-11-22): each entry's `task` names its
 *     kind (`text-generation` → `decoder_only`, `translation` /
 *     `text2text-generation` → `seq2seq`). A TEMPLATED id
 *     (`Xenova/opus-mt-{src}-{tgt}`, one model per language pair) contributes
 *     the ids its recorded EXPANSION found on the hub (`model_pins.json`
 *     `expansions`, computed by `scripts/pin_ai_models.ts --expand`) — never a
 *     pair that was not probed.
 *
 * Three readers need the same list: the store seeder (`fetch_ai_models.ts`),
 * the pin generator (`pin_ai_models.ts`) and the integrity gate
 * (`model_artifact_integrity_native`, which asserts every catalog model is
 * pinned). One copy, so the picker in the browser, the seeder and the pin
 * census can never drift on which models exist or which quantisation they use.
 *
 * (The engine's own runtime read is `src/core/ai/model_catalog.ts`, from the
 * DATABASE — a live install's registered catalog. This one reads the FILES the
 * repo ships, which is what a script on an operator's machine and a hermetic
 * gate can see.)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commonFilesFor as engineCommonFilesFor } from '../../src/core/ai/model_fetch.ts';
import { type PinTable, readPinTable } from '../../src/core/ai/model_pins.ts';
import {
	type ModelDtype,
	type ModelKind,
	modelFiles,
	withExternalData,
} from '../../src/core/ai/model_store.ts';

/** Which tool's catalogue an entry comes from. */
export type CatalogTool = 'tool_transcription' | 'tool_lang';

export interface RegisterCatalogModel {
	id: string;
	label: string;
	note: string;
	/** Quantisation: per part (transcription) or one for every session (translation). */
	dtype?: ModelDtype;
	/** The file shape. Absent = 'asr' (the transcription list's legacy default). */
	kind?: Exclude<ModelKind, 'unknown'>;
	/** The catalogue that declares it (defaults to tool_transcription for a hand-built entry). */
	tool?: CatalogTool;
	/** The transformers.js task (translation catalogue only). */
	task?: string;
	/** The templated id this entry was expanded from (`Xenova/opus-mt-{src}-{tgt}`). */
	template?: string;
}

const TOOLS_DIR = resolve(import.meta.dir, '..', '..', 'tools');

export const REGISTER_PATH = resolve(TOOLS_DIR, 'tool_transcription', 'register.json');
export const TRANSLATION_REGISTER_PATH = resolve(TOOLS_DIR, 'tool_lang', 'register.json');

/** The browser engine of tool_lang's `translator_engine` list. */
const BROWSER_ENGINE = 'browser_transformer';

/**
 * A translator task → its file shape (the transformers.js 4.2.0 session type its
 * models resolve to). An unknown task is a catalogue the reader has not learned:
 * refused loudly, never guessed.
 */
const TASK_KIND: Readonly<Record<string, Exclude<ModelKind, 'unknown'>>> = {
	'text-generation': 'decoder_only',
	translation: 'seq2seq',
	'text2text-generation': 'seq2seq',
};

/** `{src}` and `{tgt}` — the pair placeholders of a one-model-per-pair id. */
export const PAIR_TEMPLATE_RE = /\{src\}|\{tgt\}/;

/** A template filled for one ordered pair. */
export function expandTemplate(template: string, src: string, tgt: string): string {
	return template.replace('{src}', src).replace('{tgt}', tgt);
}

interface RawEntry {
	name?: string;
	label?: string;
	notes?: string;
	size_mb?: number;
	tier?: string;
	dtype?: Record<string, string>;
}

function note(entry: RawEntry): string {
	return `${entry.notes ?? ''}${entry.size_mb !== undefined ? ` (~${entry.size_mb} MB)` : ''}`.trim();
}

type RegisterMisc = Record<string, { value?: Record<string, { value?: unknown }> }[]>;

function readMisc(registerPath: string): RegisterMisc | undefined {
	return (JSON.parse(readFileSync(registerPath, 'utf8')) as { misc?: RegisterMisc }).misc;
}

/** Every browser-tier transcription model: the speaker-detection pair first, then the ASR list. */
export function readTranscriptionCatalog(
	registerPath: string = REGISTER_PATH,
): RegisterCatalogModel[] {
	const configValue = readMisc(registerPath)?.dd1633?.[0]?.value;
	const entries = configValue?.transcriber_quality?.value;
	if (!Array.isArray(entries)) {
		throw new Error(`no transcriber_quality catalog found in ${registerPath}`);
	}
	const models: RegisterCatalogModel[] = [];
	for (const slot of ['diarization_model', 'diarization_embedding_model']) {
		const entry = configValue?.[slot]?.value as RawEntry | undefined;
		if (entry !== undefined && typeof entry.name === 'string') {
			models.push({
				id: entry.name,
				label: entry.label ?? entry.name,
				note: note(entry),
				dtype: entry.dtype,
				kind: 'diarization',
				tool: 'tool_transcription',
			});
		}
	}
	for (const raw of entries) {
		if (raw === null || typeof raw !== 'object') continue;
		const entry = raw as RawEntry;
		if (typeof entry.name !== 'string') continue;
		if (entry.tier !== undefined && entry.tier !== 'browser') continue;
		models.push({
			id: entry.name,
			label: entry.label ?? entry.name,
			note: note(entry),
			dtype: entry.dtype,
			tool: 'tool_transcription',
		});
	}
	return models;
}

interface RawTranslator {
	name?: unknown;
	model_id?: unknown;
	task?: unknown;
	dtype?: unknown;
	note?: unknown;
}

/** The browser engine's `models` array, from the `dd1633` tool-config record. */
function translatorEntries(registerPath: string): unknown[] {
	const engines = readMisc(registerPath)?.dd1633?.[0]?.value?.translator_engine?.value;
	if (!Array.isArray(engines)) {
		throw new Error(`no translator_engine list found in ${registerPath}`);
	}
	const browser = engines.find(
		(engine) => (engine as { name?: unknown } | null)?.name === BROWSER_ENGINE,
	) as { models?: unknown } | undefined;
	if (!Array.isArray(browser?.models)) {
		throw new Error(`no ${BROWSER_ENGINE}.models catalogue found in ${registerPath}`);
	}
	return browser.models;
}

/** One validated translator entry, before any template expansion. */
function translatorModel(raw: unknown, registerPath: string): RegisterCatalogModel {
	const entry = (raw ?? {}) as RawTranslator;
	const where = `${registerPath} ${BROWSER_ENGINE}.models`;
	if (typeof entry.name !== 'string' || typeof entry.model_id !== 'string') {
		throw new Error(`${where}: an entry without a string name and model_id`);
	}
	const kind = typeof entry.task === 'string' ? TASK_KIND[entry.task] : undefined;
	if (kind === undefined) {
		throw new Error(
			`${where}: ${entry.name} has task ${String(entry.task)}, not one of ${Object.keys(TASK_KIND).join(', ')}`,
		);
	}
	if (typeof entry.dtype !== 'string') {
		throw new Error(`${where}: ${entry.name} declares no string dtype`);
	}
	return {
		id: entry.model_id,
		label: entry.name,
		note: typeof entry.note === 'string' ? entry.note : '',
		dtype: entry.dtype,
		kind,
		tool: 'tool_lang',
		task: entry.task as string,
	};
}

/**
 * Every in-browser TRANSLATION model, a templated entry expanded to the ids its
 * recorded expansion found (none when it was never expanded — `checkTable`
 * reports that as a problem, it is not silently an empty catalogue).
 */
export function readTranslationCatalog(
	registerPath: string = TRANSLATION_REGISTER_PATH,
	table: PinTable = readPinTable(),
): RegisterCatalogModel[] {
	const models: RegisterCatalogModel[] = [];
	for (const raw of translatorEntries(registerPath)) {
		const model = translatorModel(raw, registerPath);
		if (!PAIR_TEMPLATE_RE.test(model.id)) {
			models.push(model);
			continue;
		}
		for (const id of table.expansions?.[model.id]?.present ?? []) {
			models.push({ ...model, id, label: `${model.label} ${id}`, template: model.id });
		}
	}
	return models;
}

/** The templated ids the translation catalogue declares (the `--expand` work list). */
export function readTranslationTemplates(
	registerPath: string = TRANSLATION_REGISTER_PATH,
): RegisterCatalogModel[] {
	return translatorEntries(registerPath)
		.map((raw) => translatorModel(raw, registerPath))
		.filter((model) => PAIR_TEMPLATE_RE.test(model.id));
}

/** Every in-browser model this repo's catalogues declare: transcription, then translation. */
export function readRegisterCatalog(
	registerPath: string = REGISTER_PATH,
	translationPath: string = TRANSLATION_REGISTER_PATH,
	table: PinTable = readPinTable(),
): RegisterCatalogModel[] {
	return [
		...readTranscriptionCatalog(registerPath),
		...readTranslationCatalog(translationPath, table),
	];
}

/** The non-weight files a kind needs, and which of them may be absent upstream (the engine's table). */
export function commonFilesFor(kind: ModelKind): {
	common: readonly string[];
	optional: readonly string[];
} {
	return engineCommonFilesFor(kind);
}

/**
 * The exact file list one catalog entry needs in the store — the ENGINE's own
 * `modelFiles` (+ each weight's external-data chunks as the pin names them) plus
 * the kind's common files, so seeder, pinner and store can never disagree on
 * what "installed" means.
 */
export function filesFor(model: RegisterCatalogModel, table: PinTable = readPinTable()): string[] {
	const kind: ModelKind = model.kind ?? 'asr';
	const weights = withExternalData(model.id, modelFiles(model.dtype, kind), table);
	return [...new Set([...commonFilesFor(kind).common, ...weights])];
}
