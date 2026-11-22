/**
 * THE LOCAL AI MODEL STORE — where in-browser models come from when the archive
 * is not allowed to talk to a model hub.
 *
 * WHY THIS EXISTS. The transcription tool runs speech recognition INSIDE the
 * browser precisely because interview recordings hold personal data that must not
 * be uploaded anywhere. That promise was only half kept: the runtime came from a
 * CDN and the model weights streamed from the Hugging Face hub at inference time,
 * so a machine with no outbound internet could not transcribe at all, and a
 * machine with it announced to a third party exactly when a record was worked on.
 *
 * The runtime now comes from the client-lib registry; the WEIGHTS come from here:
 * a directory of model folders on the install's own disk, served read-only at
 * `/dedalo/ai_models/<model>/<file>`. An air-gapped institution seeds it by rsync
 * (or `bun run scripts/fetch_ai_models.ts` where there is a network) and never
 * needs the hub again.
 *
 * WHY NOT THE REPO. A single Whisper large-v3 is ~1.5 GB. It is data, not code,
 * it is not diffable, and this repo already carries scars from large files in its
 * history. The store therefore lives OUTSIDE the checkout (default: a sibling
 * `private/ai_models/`, relocatable with DEDALO_AI_MODEL_STORE), exactly like the
 * media root.
 *
 * SECURITY. Same fail-closed shape as the client-lib route: an allowlist of
 * extensions, canonical-realpath confinement to the store root, and a plain 404
 * for everything else (never an existence leak). Nothing here is writable over
 * HTTP — seeding is an operator action, not an engine action.
 *
 * INTEGRITY AT THE DOOR (2026-09-04, P1-25). A file with a known digest — the
 * repo's pin in `model_pins.json`, or the manifest's recorded sha256 — is
 * re-verified before it is served: hashed once per process (`verifiedDigest`
 * caches by stat identity) and, on a mismatch, QUARANTINED and answered 404.
 * The download side verifies what arrives; this side verifies what is about
 * to be executed in a curator's browser, so a file rewritten in the store after
 * download (a compromised rsync, a bad disk) is caught at the last moment it
 * can be. Nothing under `.quarantine` is ever servable. A file with no known
 * digest (an operator's own model) is served as before — `unverified`, never
 * refused: the store was always a folder the institution owns.
 *
 * The digest is looked up by the NAME THE REQUEST ASKS FOR (the store-relative
 * path the pin and the manifest name), and the bytes hashed are whatever that
 * name RESOLVES to. Keying the lookup on the realpath instead would let a
 * symlink planted under a pinned name — `rsync -a` carries symlinks, and the
 * header above says a compromised rsync is the threat — point at an unpinned
 * file inside the store and be served under the pinned name with no check at
 * all (refuted 2026-09-04, review of P1-25).
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { privateDir } from '../../config/env.ts';
import { readString } from '../../config/readers.ts';
import { staticAssetResponse } from '../api/static_asset.ts';
import { DedaloError, toErrorEnvelope } from '../errors/index.ts';
import { isQuarantinePath, quarantineFile, verifiedDigest } from './model_integrity.ts';
import { expectedDigest, expectedSize, forgetFile, MANIFEST_FILE } from './model_manifest.ts';
import { type PinTable, pinForPath, readPinTable } from './model_pins.ts';

/** URL prefix the store is served at. */
export const AI_MODEL_URL_PREFIX = '/dedalo/ai_models/';

/**
 * Servable extensions. Deliberately short: an ONNX model folder is weights, the
 * tokenizer/config JSON beside them, and occasionally a `.bin`/`.data` external
 * weights blob. Anything else in the directory (a README, a licence, a stray
 * script) is not part of what the browser needs and is not served.
 */
const SERVABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	'.onnx',
	'.onnx_data',
	'.json',
	'.bin',
	'.data',
	'.txt',
	'.model',
	'.wasm',
]);

/**
 * Transformers.js quantisation → ONNX filename suffix.
 *
 * THE single copy: the seeding script downloads by it and the "is this model
 * installed" check below reads by it, so a store can never look full while the
 * browser asks for a file that was never fetched.
 */
export const DTYPE_SUFFIX: Readonly<Record<string, string>> = {
	fp32: '',
	fp16: '_fp16',
	q4: '_q4',
	q4f16: '_q4f16',
	q8: '_quantized',
	int8: '_int8',
	uint8: '_uint8',
	bnb4: '_bnb4',
};

/** The config every model needs before anything else can load. */
const REQUIRED_CONFIG = 'config.json';

/**
 * WHAT KIND OF MODEL THIS IS — because the required files follow from the kind,
 * never from an assumption.
 *
 * An ASR (Whisper) folder is an encoder plus a merged decoder; a pyannote
 * SEGMENTATION or a WeSpeaker EMBEDDING folder is a single `onnx/model.onnx`.
 * Answering the second with the first's file list reported a perfectly healthy
 * speaker-detection model as `incomplete`, which disabled the checkbox, printed
 * "incomplete download" in the panel, and made the repair refusal tell the
 * administrator to re-import the tools registry — advice that cannot help,
 * because the model was never ASR-shaped at all.
 *
 * `unknown` is a real answer and NOT a synonym for `asr`: a caller that cannot
 * say (a catalog entry with neither `kind` nor `dtype`) gets an honest verdict
 * built from what is actually on disk, rather than a confident wrong one built
 * from guessed filenames. The catalog knows the kind (`register.json` carries
 * `kind: 'diarization'` on both speaker slots) — thread it, never infer it from
 * the model id.
 *
 * The two TEXT kinds (2026-11-22, tool_lang's in-browser translator catalogue)
 * are the vendored transformers.js 4.2.0 session shapes the translator's tasks
 * resolve to (`MODEL_SESSION_CONFIG` in /dedalo/lib/transformers):
 *   - `decoder_only` — a causal LM run as `text-generation` (Qwen3, Gemma3):
 *     ONE session, `onnx/model<suffix>.onnx`, usually with EXTERNAL-DATA chunks
 *     beside it (`withExternalData`);
 *   - `seq2seq` — an encoder-decoder run as `translation` / `text2text-generation`
 *     (M2M100/NLLB, T5/MADLAD, Marian/opus-mt): `onnx/encoder_model<suffix>.onnx`
 *     + `onnx/decoder_model_merged<suffix>.onnx`.
 * The catalogue reader maps a task to its kind; `scripts/pin_ai_models.ts`
 * cross-checks the resulting file set against the vendored runtime's own
 * `ModelRegistry.get_model_files` on each model's REAL config before a pin is
 * written, and `model_artifact_integrity_native` leg (k) holds the mirror.
 */
export type ModelKind = 'asr' | 'diarization' | 'decoder_only' | 'seq2seq' | 'unknown';

/**
 * A catalog's quantisation: one dtype for every session (tool_lang's catalogue,
 * `"q4"`), or one per weight part (tool_transcription's, keyed by the ONNX base
 * name: `{encoder_model: 'fp16', decoder_model_merged: 'q4f16'}`).
 */
export type ModelDtype = string | Record<string, string>;

/**
 * The weight parts a kind has when the catalog declares no `dtype` — the fp32
 * placeholder names. `unknown` has none: there is nothing to place.
 */
const DEFAULT_PARTS: Readonly<Record<ModelKind, Record<string, string>>> = {
	asr: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
	diarization: { model: 'fp32' },
	decoder_only: { model: 'fp32' },
	seq2seq: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
	unknown: {},
};

/**
 * The weight-file prefixes a kind's ONNX directory must hold, used by the
 * dtype-less fallback to recognise a quantised install by its real filenames.
 * EVERY prefix must be matched: an ASR model needs both halves, a diarization
 * model needs its one.
 */
const WEIGHT_PREFIXES: Readonly<Record<ModelKind, readonly string[]>> = {
	asr: ['encoder_model', 'decoder_model_merged'],
	diarization: ['model'],
	decoder_only: ['model'],
	seq2seq: ['encoder_model', 'decoder_model_merged'],
	unknown: [],
};

/**
 * The per-part quantisation a dtype declares: a per-part record as it is, a
 * single dtype applied to EVERY part of the kind (what transformers.js does with
 * a string `dtype`), the fp32 placeholders when there is none.
 */
function dtypeParts(dtype: ModelDtype | undefined, kind: ModelKind): Record<string, string> {
	if (dtype === undefined) return DEFAULT_PARTS[kind];
	if (typeof dtype !== 'string') return dtype;
	return Object.fromEntries(Object.keys(DEFAULT_PARTS[kind]).map((part) => [part, dtype]));
}

/**
 * The exact files one catalog entry needs in the store to be USABLE — its config
 * plus the ONNX weights for the quantisation the catalog declares. A model whose
 * config is present but whose weights are the wrong variant is NOT installed, and
 * saying so here is what stops the browser failing later with "Could not locate
 * file" from inside the ONNX runtime.
 *
 * `kind` decides the placeholder names used when there is no `dtype` (and the
 * parts a single-string dtype applies to); with a per-part record, the
 * declaration itself names the parts and the kind changes nothing.
 *
 * The weights' EXTERNAL-DATA chunks are not here — they are a fact of one model's
 * config, not of its kind; `withExternalData` adds them.
 */
export function modelFiles(dtype?: ModelDtype, kind: ModelKind = 'asr'): string[] {
	const parts = dtypeParts(dtype, kind);
	const files = [REQUIRED_CONFIG];
	for (const [part, quant] of Object.entries(parts)) {
		const suffix = DTYPE_SUFFIX[quant];
		if (suffix === undefined) continue; // an unknown dtype is a catalog bug, not a missing file
		files.push(`onnx/${part}${suffix}.onnx`);
	}
	return files;
}

/**
 * The external-data chunk NAMES transformers.js 4.2.0 requests beside one ONNX
 * file (`getExternalDataChunkNames`): `<file>_data`, `<file>_data_1`, … — and
 * how many, from a config's `transformers.js_config.use_external_data_format`
 * as the LOADER resolves it (`getSession` → `resolveExternalDataFormat`: keyed
 * by the full file name, else by the part's base name, else one bare
 * number/boolean for every file). Pure: the pin procedure feeds it the hub
 * config at the pinned revision; leg (k) of `model_artifact_integrity_native`
 * holds it to the vendored runtime.
 *
 * (!) The loader, not `ModelRegistry.get_model_files`: in 4.2.0 the registry
 * helper looks a per-part dtype / chunk count up by SESSION key (`model` for an
 * encoder) while the loader that actually opens the sessions uses the BASE name
 * (`encoder_model`). They agree for a single-string dtype and full-name chunk
 * keys — every translator's case — and the loader wins where they do not.
 */
/** A per-file `use_external_data_format` map: the full name first, then the part's base name. */
function keyedChunkCount(keyed: Record<string, unknown>, fullName: string, part: string): number {
	if (Object.hasOwn(keyed, fullName)) return Number(keyed[fullName]);
	return Object.hasOwn(keyed, part) ? Number(keyed[part]) : 0;
}

/** The chunk count one `use_external_data_format` value gives a weight (loader order). */
function declaredChunkCount(format: unknown, fullName: string, part: string): number {
	if (format !== null && typeof format === 'object') {
		return keyedChunkCount(format as Record<string, unknown>, fullName, part);
	}
	return format === undefined || format === null || format === false ? 0 : Number(format);
}

export function externalDataChunkNames(config: unknown, fullName: string, part: string): string[] {
	const format = (
		config as { 'transformers.js_config'?: { use_external_data_format?: unknown } } | null
	)?.['transformers.js_config']?.use_external_data_format;
	const chunks = declaredChunkCount(format, fullName, part);
	if (!Number.isInteger(chunks) || chunks < 0 || chunks > MAX_EXTERNAL_DATA_CHUNKS) {
		throw new DedaloError('ai.model_integrity', {
			message: `${fullName}: use_external_data_format ${String(chunks)} is not 0..${MAX_EXTERNAL_DATA_CHUNKS}`,
		});
	}
	return Array.from({ length: chunks }, (_, index) =>
		index === 0 ? `${fullName}_data` : `${fullName}_data_${index}`,
	);
}

/**
 * `modelFiles` with every weight's external-data chunks as ONE CONFIG declares
 * them — the full weight set the runtime loads for that config. Used where the
 * config is in hand (the pin procedure, the gate's runtime mirror); the store
 * and the downloader read the same answer back from the pin (`withExternalData`).
 */
export function modelFilesForConfig(
	dtype: ModelDtype | undefined,
	kind: ModelKind,
	config: unknown,
): string[] {
	const files = [REQUIRED_CONFIG];
	for (const [part, quant] of Object.entries(dtypeParts(dtype, kind))) {
		const suffix = DTYPE_SUFFIX[quant];
		if (suffix === undefined) continue;
		const fullName = `${part}${suffix}.onnx`;
		files.push(`onnx/${fullName}`);
		for (const chunk of externalDataChunkNames(config, fullName, part)) files.push(`onnx/${chunk}`);
	}
	return files;
}

/** transformers.js 4.2.0's own ceiling (`MAX_EXTERNAL_DATA_CHUNKS`). */
const MAX_EXTERNAL_DATA_CHUNKS = 100;

/** `<weight>.onnx_data` or `<weight>.onnx_data_<n>` — an external-data chunk name. */
const EXTERNAL_DATA_RE = /\.onnx_data(?:_(\d+))?$/;

/** The chunk index of an external-data name (`_data` = 0), or null when it is not one. */
function chunkIndex(file: string): number | null {
	const match = EXTERNAL_DATA_RE.exec(file);
	if (match === null) return null;
	return match[1] === undefined ? 0 : Number(match[1]);
}

/**
 * A file list with each ONNX weight's EXTERNAL-DATA chunks added after it.
 *
 * Which chunks a weight HAS is its config's answer (`externalDataChunkNames`),
 * read ONCE, at pin time, and recorded as the pin's files — so for a PINNED
 * model the pin names them, and the verdict and the downloader need no config
 * read (a request-path sync read the store does not make). An UNPINNED model (an
 * operator's own rsync) has no such record; its chunks are the ones ON DISK,
 * which evidences what is there (a truncated chunk still shows) but cannot see a
 * chunk that was never copied — the same honest limit as `unknown`.
 */
export function withExternalData(
	modelId: string,
	files: readonly string[],
	table: PinTable = readPinTable(),
	root: string | null = null,
): string[] {
	const pinned = table.models[modelId];
	const candidates =
		pinned !== undefined
			? Object.keys(pinned.files)
			: root !== null
				? (onnxDirEntries(root, modelId) ?? []).map((name) => `onnx/${name}`)
				: [];
	const out: string[] = [];
	for (const file of files) {
		out.push(file);
		if (!file.endsWith('.onnx')) continue;
		const chunks = candidates
			.filter((name) => name.startsWith(file) && /^_data(?:_\d+)?$/.test(name.slice(file.length)))
			.sort((a, b) => (chunkIndex(a) as number) - (chunkIndex(b) as number));
		out.push(...chunks);
	}
	return out;
}

/**
 * True when the browser can actually LOAD this model from the store.
 *
 * With a `dtype` (the catalog's declaration) the check is exact: those files, or
 * not installed. WITHOUT one — an older registered catalog that predates the
 * per-model quantisation, which is what a live install has until the tools
 * registry is re-imported — an exact check would be a guess, and guessing fp32
 * would report every store empty. So the fallback asks the weaker but true
 * question: is there a config and at least one encoder AND one decoder variant?
 */
export function modelInstalled(
	modelId: string,
	dtype?: ModelDtype,
	kind: ModelKind = 'asr',
): boolean {
	const root = modelStoreRoot();
	const present = (file: string): boolean => {
		const path = resolve(root, modelId, file);
		try {
			return existsSync(path) && statSync(path).size > 0;
		} catch {
			return false;
		}
	};

	if (dtype !== undefined) {
		return withExternalData(modelId, modelFiles(dtype, kind), readPinTable(), root).every(present);
	}

	if (!present(REQUIRED_CONFIG)) return false;
	const weights = onnxDirEntries(root, modelId);
	if (weights === null) return false;
	const has = (prefix: string): boolean =>
		weights.some((file) => file.startsWith(prefix) && file.endsWith('.onnx'));
	// An UNKNOWN kind has no prefix list to satisfy: any weight file at all is the
	// most that can honestly be asserted (`every` over an empty list would say
	// "installed" for a store with none, so ask the disk instead).
	if (kind === 'unknown') return weights.some((file) => file.endsWith('.onnx'));
	return WEIGHT_PREFIXES[kind].every(has);
}

/** The model's `onnx/` listing, or null when there is no such directory. */
function onnxDirEntries(root: string, modelId: string): string[] | null {
	try {
		return readdirSync(resolve(root, modelId, 'onnx'));
	} catch {
		return null;
	}
}

/**
 * The weight filenames `modelState` should evidence for a DTYPE-LESS lookup —
 * the same "any variant present" fallback `modelInstalled` documents above,
 * expressed as real filenames instead of a boolean. Empty when the store does
 * not have BOTH an encoder and a decoder variant, so the caller falls back to
 * the fp32 placeholder names (which correctly reports "missing"/"incomplete"
 * for a genuinely empty or partial store — see modelState).
 */
function fallbackWeightsFiles(root: string, modelId: string, kind: ModelKind): string[] {
	const weights = onnxDirEntries(root, modelId);
	if (weights === null) return [];
	// An UNKNOWN kind cannot say which weights SHOULD be there, so it reports on
	// the ones that ARE: real names, from the disk itself, and never a guess that
	// would manufacture an `incomplete` verdict out of an assumption.
	if (kind === 'unknown') {
		return weights.filter((file) => file.endsWith('.onnx')).map((file) => `onnx/${file}`);
	}
	const found: string[] = [];
	for (const prefix of WEIGHT_PREFIXES[kind]) {
		const match = weights.find((file) => file.startsWith(prefix) && file.endsWith('.onnx'));
		if (match === undefined) return []; // an incomplete pair names nothing
		found.push(`onnx/${match}`);
	}
	return found;
}

/**
 * What the store can honestly say about one model.
 *
 * `unverified` is not a hedge, it is the truth about a store seeded before the
 * completion manifest existed: TRUNCATION CANNOT BE SEEN IN THE BYTES. A header
 * probe catches a file that is the wrong KIND of thing (an HTML error page saved
 * as weights); only a comparison against a known expected length catches a file
 * that is the right kind and half as long. This function performs no network I/O,
 * so where there is no manifest there is no verdict to give — the `verify_model`
 * action is what resolves it.
 */
export type ModelState = 'ready' | 'unverified' | 'incomplete' | 'damaged' | 'missing';

export interface ModelFileEvidence {
	file: string;
	present: boolean;
	size: number;
	/** The manifest's recorded length, or null when never recorded. */
	expected: number | null;
	/**
	 * The leading bytes are the RIGHT KIND of payload (see headerPlausible).
	 * PER FILE, not per model: a repair that deletes every file because ONE of
	 * them is an HTML error page destroys the ones that were fine — and, on the
	 * dtype-less path, cannot name them again to fetch them back.
	 */
	plausible: boolean;
}

export interface ModelStateReport {
	state: ModelState;
	files: ModelFileEvidence[];
	/**
	 * The file NAMES in `files` are real, not guessed.
	 *
	 * True when the catalog declared a `dtype` (the names follow from it) or when
	 * the store itself supplied them (fallbackWeightsFiles reads the directory).
	 * FALSE means the names are the fp32 placeholders `modelFiles()` invents for
	 * a dtype-less catalog whose store holds no complete weight pair — a caller
	 * may report on them, but must NEVER delete a weight file on their authority:
	 * the quantisation actually installed is unknown, so what was removed could
	 * not be fetched back (a 400 MB q4 install replaced by a ~3 GB fp32 set the
	 * browser never asks for).
	 */
	namesKnown: boolean;
}

/**
 * The leading bytes of a file that claims to be ONNX or JSON.
 *
 * An ONNX file is a protobuf ModelProto: its first field is `ir_version`
 * (field 1, varint) so the first byte is 0x08 in every model the hub publishes.
 * A JSON payload starts with '{' or '[' (leading whitespace tolerated — a
 * pretty-printed config is not damaged). Anything else — most usefully '<' — is
 * a transport artefact written to disk under a model file's name.
 *
 * A file of a kind we have no rule for is NOT called implausible: no rule means
 * no verdict, and inventing one here would report a healthy install damaged.
 */
const JSON_WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** '{' or '[' after any leading whitespace — a pretty-printed config is fine. */
function jsonHeadPlausible(head: Buffer, read: number): boolean {
	for (let i = 0; i < read; i++) {
		const byte = head[i] as number;
		if (JSON_WHITESPACE.has(byte)) continue;
		return byte === 0x7b || byte === 0x5b;
	}
	return false; // whitespace only
}

/** The verdict for the bytes we read, by file kind. Unknown kind ⇒ no verdict. */
function headPlausible(head: Buffer, read: number, file: string): boolean {
	if (file.endsWith('.json')) return jsonHeadPlausible(head, read);
	if (file.endsWith('.onnx')) return head[0] === 0x08;
	return true;
}

function headerPlausible(path: string, file: string): boolean {
	let fd: number | null = null;
	try {
		fd = openSync(path, 'r');
		const head = Buffer.alloc(8);
		const read = readSync(fd, head, 0, 8, 0);
		if (read < 1) return false;
		return headPlausible(head, read, file);
	} catch {
		return false;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * What the disk says about ONE file of one model, whatever list it came from.
 *
 * Exported because `modelState` only evidences the files a model NEEDS TO RUN
 * (config + weights), while a repair must also answer for the common files
 * (tokenizer.json, preprocessor_config.json…) — a corrupt tokenizer used to
 * survive a repair that then reported success, and a wrong "success" is the one
 * outcome this subsystem forbids.
 */
export function fileEvidence(root: string, modelId: string, file: string): ModelFileEvidence {
	const path = resolve(root, modelId, file);
	let size = 0;
	let present = false;
	try {
		present = existsSync(path);
		size = present ? statSync(path).size : 0;
	} catch {
		present = false;
	}
	return {
		file,
		present,
		size,
		expected: expectedSize(root, modelId, file),
		plausible: present && size > 0 ? headerPlausible(path, file) : false,
	};
}

export function modelState(
	modelId: string,
	dtype?: ModelDtype,
	kind: ModelKind = 'asr',
): ModelStateReport {
	const root = modelStoreRoot();
	// No dtype declared: an older registered catalog that predates per-model
	// quantisation — which getToolConfig reading straight from the DB makes a
	// LIVE case, not a historical one. Guessing the fp32 filenames would report
	// a quantised install as "missing"; use the real filenames on disk when the
	// modelInstalled fallback (any encoder + any decoder variant) is satisfied,
	// and only fall back to the fp32 placeholders when it is not — which keeps
	// the correct "missing"/"incomplete" verdict for a genuinely empty/partial
	// store.
	//
	// The file list follows the model's KIND, never an ASR assumption: a pyannote
	// segmentation folder holds config.json + onnx/model.onnx and nothing else, so
	// demanding an encoder/decoder pair of it reported a healthy speaker model
	// `incomplete` and aimed a repair at a shape it does not have.
	const fallbackFound = dtype === undefined ? fallbackWeightsFiles(root, modelId, kind) : [];
	// Each weight's external-data chunks ride with it (the pin names them; see
	// withExternalData): a decoder-only translator whose `onnx/model_q4.onnx`
	// is present but whose `…onnx_data_1` is not would otherwise read `ready`
	// and fail inside the ONNX runtime.
	const wanted = withExternalData(
		modelId,
		dtype !== undefined
			? modelFiles(dtype, kind)
			: fallbackFound.length > 0
				? [REQUIRED_CONFIG, ...fallbackFound]
				: modelFiles(undefined, kind),
		readPinTable(),
		root,
	);

	// With an UNKNOWN kind and no dtype there are no placeholder names to fall
	// back to (modelFiles yields the config alone), so a store holding weights we
	// cannot classify is never called `incomplete` on the strength of a guess.
	const namesKnown = dtype !== undefined || fallbackFound.length > 0;
	const files: ModelFileEvidence[] = wanted.map((file) => fileEvidence(root, modelId, file));
	const verdict = (state: ModelState): ModelStateReport => ({ state, files, namesKnown });

	if (files.every((entry) => !entry.present || entry.size === 0)) return verdict('missing');
	if (files.some((entry) => !entry.present || entry.size === 0)) return verdict('incomplete');
	// Wrong KIND of content beats wrong LENGTH: an HTML error page is a damaged
	// install whatever the manifest claims, and it names a different remedy.
	if (files.some((entry) => !entry.plausible)) return verdict('damaged');
	if (files.some((entry) => entry.expected !== null && entry.expected !== entry.size)) {
		return verdict('incomplete');
	}
	if (files.every((entry) => entry.expected !== null)) return verdict('ready');
	return verdict('unverified');
}

/**
 * The store root. `DEDALO_AI_MODEL_STORE` when set (absolute, or relative to the
 * private dir), else `<private>/ai_models`.
 *
 * Read per call rather than memoized: the tests relocate it, and the cost is one
 * env lookup against a request that is about to move megabytes.
 */
export function modelStoreRoot(): string {
	const configured = (readString('DEDALO_AI_MODEL_STORE') ?? '').trim();
	if (configured === '') return resolve(privateDir, 'ai_models');
	return resolve(privateDir, configured);
}

/**
 * The canonical store root, or null when there is no store this route may serve
 * from. Confinement is measured against the CANONICAL path because the store is
 * very likely a symlink to a data volume, so comparing raw strings would confine
 * to a path nothing actually reads.
 */
export function canonicalModelStoreRoot(): string | null {
	const root = modelStoreRoot();
	if (!existsSync(root)) return null;
	if (!modelStoreRootIsSane(root)) return null;
	try {
		return realpathSync(root);
	} catch {
		return null;
	}
}

/**
 * Whether a resolved store root is one this route may serve FROM.
 *
 * `resolve(privateDir, configured)` accepts anything, including `.` and `..`.
 * A store of `.` resolves to the PRIVATE DIRECTORY itself, and every
 * allowlisted-extension file under it — configuration, exports, whatever an
 * operator has put there — becomes readable over this route. `..` reaches its
 * parent. Neither is a traversal the confinement check can catch: the confinement
 * is measured against the root, and the root is the thing that moved.
 *
 * The rule is not "inside privateDir" — an air-gapped institution legitimately
 * rsyncs weights to a data volume at an absolute path of its own. The rule is
 * that the store must not CONTAIN the engine's other state: a root equal to, or
 * an ancestor of, the private directory is refused. That is decidable from the
 * paths themselves, needs no marker file, and stays true wherever the store lives.
 */
export function modelStoreRootIsSane(root: string): boolean {
	let canonicalRoot: string;
	let canonicalPrivate: string;
	try {
		canonicalRoot = realpathSync(root);
		canonicalPrivate = realpathSync(privateDir);
	} catch {
		return false;
	}
	if (canonicalRoot === canonicalPrivate) return false;
	// an ancestor of the private directory swallows everything under it
	return !canonicalPrivate.startsWith(canonicalRoot + sep);
}

/** True when the store directory exists — the honest answer to "can we run locally". */
export function modelStoreAvailable(): boolean {
	const root = modelStoreRoot();
	try {
		return existsSync(root) && statSync(root).isDirectory();
	} catch {
		return false;
	}
}

/**
 * True when the engine may fall back to a public model hub. Default FALSE: the
 * privacy promise is the default, and an install that wants the convenience of
 * on-demand downloads has to say so.
 */
export function modelHubAllowed(): boolean {
	return (readString('DEDALO_AI_MODEL_ALLOW_HUB') ?? '').trim() === 'true';
}

/**
 * A store path a request named, resolved: the NAME it asked for (store-relative,
 * `..` normalised — the name a pin or a manifest entry is keyed by) and the
 * canonical file that name currently points at (the bytes that get served).
 * The two differ exactly when a symlink sits somewhere under the requested name.
 */
export interface ResolvedStorePath {
	/** Canonical store root the path is confined to. */
	canonicalRoot: string;
	/** Store-relative requested name, e.g. `Xenova/whisper-small/config.json`. */
	requested: string;
	/** Realpath of the file the name resolves to; confined to the store. */
	realFull: string;
}

/**
 * Resolve `/dedalo/ai_models/<subpath>` to a confined store path, or null to
 * 404. Both the requested name and the realpath are confined (the realpath
 * again after following symlinks); NEITHER may sit under `.quarantine`.
 */
export function resolveStorePath(subPath: string): ResolvedStorePath | null {
	// One call answers "is there a store, is it a legitimate one, and what is its
	// canonical path" — the three questions that must all hold before anything is
	// confined to it.
	const canonicalRoot = canonicalModelStoreRoot();
	if (canonicalRoot === null) return null;

	const fullPath = resolve(canonicalRoot, subPath);
	if (!withinServableStore(canonicalRoot, fullPath)) return null; // traversal attempt
	if (!isServableFile(fullPath)) return null;
	if (!existsSync(fullPath)) return null;
	// MODEL-02 (2026-07-28 audit): the string check above only confines resolve()'s
	// path — a SYMLINK LEAF inside the store still reads its target. Realpath the
	// final file and RE-CONFINE, so a symlink pointing OUT of the store (planted
	// by whoever seeded it, or a crafted rsync) cannot exfiltrate an arbitrary
	// file through this anonymous route.
	let realFull: string;
	try {
		realFull = realpathSync(fullPath);
	} catch {
		return null;
	}
	if (!withinServableStore(canonicalRoot, realFull)) return null;
	return { canonicalRoot, requested: relative(canonicalRoot, fullPath), realFull };
}

/**
 * The confined absolute (real) path `/dedalo/ai_models/<subpath>` names, or null
 * to 404. Exported so a gate can assert the mapping without standing a server up.
 */
export function resolveModelPath(subPath: string): string | null {
	return resolveStorePath(subPath)?.realFull ?? null;
}

/**
 * Confined under the canonical root AND outside `.quarantine`. Evidence of a
 * refused artifact is kept for the operator, never served — judged on the
 * RESOLVED path (and again on the realpath), so `a/../.quarantine/x` cannot
 * dodge it.
 */
function withinServableStore(canonicalRoot: string, path: string): boolean {
	if (path !== canonicalRoot && !path.startsWith(canonicalRoot + sep)) return false;
	return !isQuarantinePath(relative(canonicalRoot, path));
}

/**
 * Which model and file a store-relative path names, together with the digest
 * the store KNOWS for it — or null when it knows none.
 *
 * A model id is `org/name` on the hub but the store does not fix the depth, so
 * every split of the path is a candidate. TWO PASSES, by AUTHORITY, never by
 * depth: first the REPO PIN at any split, only then a MANIFEST at any split.
 * A single pass that took the first split with ANY digest let a manifest
 * planted one directory UP (`<store>/Xenova/.dedalo_model.json` claiming
 * `whisper-small/config.json`) answer before the repo pin of
 * `Xenova/whisper-small` was ever consulted — and the manifest is exactly the
 * store-writable file a compromised rsync controls (refuted 2026-09-04, review
 * of P1-25). The pin is not store-writable; it is the authority, at every depth.
 *
 * The pin pass is `pinForPath`: exact name at every depth, then CASE-FOLDED —
 * on a case-insensitive filesystem a differently-cased request names the same
 * bytes, and those bytes carry the pin (review of P1-25, 2026-09-04).
 *
 * Within the manifest pass the DEEPEST split wins: a manifest vouches for the
 * files of its OWN directory (`onnx/model.onnx` under `org/name/`), and a
 * directory that carries its own manifest is never spoken for by an ancestor's.
 * Honest limit: a writer who can rewrite the model's own manifest is trusted by
 * it — the manifest was always this install's own claim, which is why the pin
 * exists. Exported for the gate.
 */
export function knownDigestFor(
	relPath: string,
): { modelId: string; file: string; sha256: string; source: 'pin' | 'manifest' } | null {
	const root = modelStoreRoot();
	const segments = relPath.split(sep);
	const pinned = pinForPath(segments.join('/'));
	if (pinned !== null) {
		return { modelId: pinned.modelId, file: pinned.file, sha256: pinned.pin.sha256, source: 'pin' };
	}
	// Deepest model directory first.
	for (let split = segments.length - 1; split >= 1; split--) {
		const modelId = segments.slice(0, split).join('/');
		const file = segments.slice(split).join('/');
		const recorded = expectedDigest(root, modelId, file);
		if (recorded !== null) return { modelId, file, sha256: recorded, source: 'manifest' };
	}
	return null;
}

/**
 * The serve-side integrity verdict: true when the file may be served. A file
 * with a known digest that does not hash to it is quarantined (and its manifest
 * claim dropped) so the next request 404s without re-hashing.
 *
 * The digest is KNOWN for the REQUESTED name and the bytes hashed are the ones
 * that name RESOLVES to — never the other way round (see the module header: a
 * symlink under a pinned name pointing at an unpinned store file must be judged
 * against the pin of the name it hides behind). What gets quarantined is the
 * requested name: for a symlink leaf that is the link itself, the evidence.
 */
async function servable(resolved: ResolvedStorePath): Promise<boolean> {
	const known = knownDigestFor(resolved.requested);
	if (known === null) return true;
	const actual = await verifiedDigest(resolved.realFull);
	if (actual === known.sha256) return true;
	console.error(
		`[ai] refusing to serve '${resolved.requested}': sha256 ${actual ?? 'unreadable'} != ${known.source} ${known.sha256}`,
	);
	quarantineFile(resolved.canonicalRoot, resolved.requested);
	forgetFile(modelStoreRoot(), known.modelId, known.file);
	return false;
}

/**
 * The absolute path this URL names inside the store, VERIFIED, or null when it
 * names none — an undecodable escape sequence included, which is a refusal like
 * any other rather than a throw the route would have to catch — or names a file
 * whose bytes fail their known digest (quarantined on the way).
 */
async function storePathFor(pathname: string): Promise<string | null> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const resolved = resolveStorePath(decoded.slice(AI_MODEL_URL_PREFIX.length));
	if (resolved === null) return null;
	// The integrity verdict is part of "does this URL name a servable file".
	return (await servable(resolved)) ? resolved.realFull : null;
}

/**
 * Serve a `/dedalo/ai_models/*` request, or return null when the pathname is not
 * one (the caller falls through to the next handler).
 *
 * SESSION-GATED, fail-closed (2026-08-28). The store is weights: single files
 * reach the gigabyte, and they are served `immutable` with no rate limit. While
 * no proxy config routed this path it was unreachable from outside and the
 * anonymity cost nothing; routing it made an unauthenticated, unbounded
 * download the only one on the vhost. The sole consumer is a same-origin worker
 * inside the logged-in app (`remove_background.js` points transformers.js at
 * this origin), so it always carries the session cookie — nothing legitimate
 * asks for a model anonymously.
 *
 * The caller resolves the session (this module must not import the session
 * store — it is a leaf of the AI subsystem, and the SCC tripwire keeps it one)
 * and passes the verdict. The REFUSAL lives here, with the handler, so a future
 * second caller cannot reintroduce the anonymous route by forgetting it.
 *
 * Model files are immutable once written — a model id names an exact set of
 * weights — so they are served with a long-lived cache, which is what keeps a
 * second transcription from re-downloading a gigabyte over the LAN. The cache
 * is PRIVATE (ROUTE-01 residual): `public` invites a shared or proxy cache to
 * hand the bytes to the next caller with no session at all, re-opening the
 * anonymous door the session gate just closed. The browser's own cache is the
 * only one that may keep a copy.
 *
 * ROUTE-01 "metered" — DECISION: the engine has no rate-limit primitive, and
 * a per-session byte meter would be a bespoke mechanism for one route. The
 * unbounded-download exposure is closed by the session gate (an authenticated
 * curator, revocable) + the private cache (no anonymous replay through a
 * shared cache) + the integrity check above; per-session download metering
 * is OUT OF SCOPE here and would be an engine-wide concern if ever needed.
 */
export async function serveModelRequest(
	pathname: string,
	request: Request,
	hasSession: boolean,
): Promise<Response | null> {
	if (!pathname.startsWith(AI_MODEL_URL_PREFIX)) return null;
	// Same 404 as a missing file: an anonymous caller learns nothing about the
	// store's existence or contents.
	if (hasSession !== true) return notFound();

	const fullPath = await storePathFor(pathname);
	if (fullPath === null) return notFound();

	const response = await staticAssetResponse(fullPath, request);
	if (response === null) return notFound();

	// Immutable content: a model id IS its version — cached by THIS browser only.
	if (response.status === 200) {
		response.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
	}
	return response;
}

/**
 * May this NAME be served at all? An allowlisted extension, and not the
 * completion manifest.
 *
 * The manifest is INTERNAL bookkeeping and it is `.json`, so the extension
 * allowlist alone would serve it on this anonymous route. The browser never asks
 * for it — it loads config.json, the tokenizer/preprocessor JSON and the
 * weights — while the manifest names this install's own files and their exact
 * byte lengths. Nothing needs it; nobody outside gets it.
 */
function isServableFile(fullPath: string): boolean {
	if (!SERVABLE_EXTENSIONS.has(servableExtension(fullPath))) return false;
	return basename(fullPath) !== MANIFEST_FILE;
}

/**
 * The allowlist key of a name. An external-data chunk past the first is
 * `model_q4.onnx_data_1` — `extname` calls that `.onnx_data_1`, which the
 * allowlist never named, so every decoder-only translator (whose q4 weights
 * span two or more chunks) 404'd on its second chunk. Every chunk is the one
 * `.onnx_data` kind.
 */
function servableExtension(fullPath: string): string {
	const extension = extname(fullPath).toLowerCase();
	return /^\.onnx_data_\d+$/.test(extension) ? '.onnx_data' : extension;
}

/** 404 without leaking whether the target exists. */
function notFound(): Response {
	// Converter-made body (ERRORS_SPEC §4): this is a STATIC route, so it never
	// entered the dispatch chokepoint and has no correlation id to reuse — the
	// envelope gets a fresh one rather than a fake constant.
	const { status, body } = toErrorEnvelope(new DedaloError('resource.not_found'), {
		requestId: crypto.randomUUID(),
	});
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
