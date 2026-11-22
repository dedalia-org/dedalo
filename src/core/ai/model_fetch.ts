/**
 * MODEL DOWNLOADER — pull one model's files from the public hub into the local
 * store. The ONE implementation behind both doors:
 *
 *   - `scripts/fetch_ai_models.ts` (the operator CLI, with a progress bar);
 *   - the tool's admin-gated `download_model` action (quiet, in a background job),
 *     which is how an administrator seeds a model from the browser without shell
 *     access to the server.
 *
 * Downloading is an OPERATOR/ADMIN act, distinct from `DEDALO_AI_MODEL_ALLOW_HUB`:
 * that flag governs whether the BROWSER may stream weights from the hub at
 * inference time (a per-recording privacy leak); this module runs on the server,
 * once per model, on an explicit request. An air-gapped install simply gets a
 * clean failure here and seeds the store by rsync instead.
 *
 * Transport is `curl` (resume, retry, and — observed on this project's own dev
 * box — Bun's fetch stalling outright against the hub's CDN redirect), with a
 * fetch fallback for hosts without curl. Files land only under the store root,
 * and only for model ids the CALLER has already validated against the catalog —
 * this module never invents a URL from user input on its own.
 *
 * PINNED AND VERIFIED (2026-09-04, P1-25 / CARRY-06). A file is fetched at the
 * IMMUTABLE hub revision recorded in `model_pins.json` — never the mutable
 * `main` head — and after transport its bytes are sha256-hashed against the pin
 * BEFORE the manifest records completion. A mismatch is quarantined under
 * `<store>/.quarantine` (evidence kept, file never served) and reported as a
 * refusal; a model with no pin is refused before any byte, because a download
 * the engine cannot verify is a download it must not make. The transport's
 * `-C -` resume is exactly why the length test was never enough: a resumed file
 * can carry the head of one object and the tail of another at the right length.
 *
 * The DECISIONS live in three pure exports — `resolveFetchTarget` (path
 * confinement + URL policy), `curlArgv` (transport flags) and
 * `isUsableCachedFile` (cache freshness) — gated by
 * `test/unit/ai_model_fetch_native.test.ts`. What remains is byte plumbing,
 * split one concern per function (`acceptCached` / `verifyAndRecord` for the
 * digest verdict and manifest bookkeeping, `curlFetch` / `plainFetch` — over `idleAbort` /
 * `streamToFile` / `pumpToWriter` — and `transport` for the wire),
 * so `fetchOneFile` reads as the six-line sequence it is. The whole path —
 * transport included — is driven against a LOOPBACK hub by
 * `test/unit/model_artifact_integrity_native.test.ts`; the orchestration in
 * `downloadModel` is also drivable through the injectable `options.fetchFile`.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileSink } from 'bun';

/** A model id / file segment: word chars, dot, slash, hyphen — and NEVER `..`. */
const SAFE_MODEL_SEGMENT = /^[A-Za-z0-9._/-]+$/;
function isSafeModelSegment(value: string): boolean {
	return value !== '' && SAFE_MODEL_SEGMENT.test(value) && !value.split('/').includes('..');
}

import { forgetVerdict, quarantineFile, verifiedDigest } from './model_integrity.ts';
import { expectedDigest, forgetFile, recordFileComplete } from './model_manifest.ts';
import {
	type FilePin,
	type PinTable,
	pinFor,
	pinnedRevision,
	REVISION_HEX,
	readPinTable,
} from './model_pins.ts';
import {
	type ModelDtype,
	type ModelKind,
	modelFiles,
	modelStoreRoot,
	withExternalData,
} from './model_store.ts';

/** Where model files are fetched from when a download is requested. */
export const HUB_BASE = 'https://huggingface.co';

/** Files every model needs regardless of quantisation (modelFiles adds the weights). */
export const COMMON_FILES: readonly string[] = [
	'generation_config.json',
	'preprocessor_config.json',
	'tokenizer.json',
	'tokenizer_config.json',
];

/** Files a model may legitimately lack (not every repo publishes every one). */
export const OPTIONAL_FILES: readonly string[] = [
	'generation_config.json',
	'preprocessor_config.json',
];

/**
 * The common files of a DIARIZATION model (pyannote segmentation): no
 * tokenizer, no generation config — but the preprocessor config is REQUIRED
 * (AutoProcessor cannot build without it), so unlike the ASR list nothing
 * here is optional. Callers pass these via DownloadOptions when the catalog
 * entry declares `kind: 'diarization'`.
 */
export const DIARIZATION_COMMON_FILES: readonly string[] = ['preprocessor_config.json'];

/**
 * The common files of a TEXT model (tool_lang's translators, kinds
 * `decoder_only` / `seq2seq`) — what transformers.js 4.2.0's
 * `get_pipeline_files` names for a `text` task beside the weights: the
 * tokenizer pair (present whenever the repo publishes `tokenizer_config.json`,
 * which every catalogue translator does) and the OPTIONAL generation config
 * (`optional_configs`; MADLAD publishes none). No preprocessor: a text task
 * loads no processor.
 */
export const TEXT_COMMON_FILES: readonly string[] = [
	'generation_config.json',
	'tokenizer.json',
	'tokenizer_config.json',
];
export const TEXT_OPTIONAL_FILES: readonly string[] = ['generation_config.json'];

/**
 * THE per-kind table of non-weight files: which to fetch, and which may be
 * absent upstream. The one copy the downloader defaults from and the scripts
 * (seeder, pinner, gate) read through `scripts/lib/ai_model_register.ts`.
 */
export function commonFilesFor(kind: ModelKind): {
	common: readonly string[];
	optional: readonly string[];
} {
	if (kind === 'diarization') return { common: DIARIZATION_COMMON_FILES, optional: [] };
	if (kind === 'decoder_only' || kind === 'seq2seq') {
		return { common: TEXT_COMMON_FILES, optional: TEXT_OPTIONAL_FILES };
	}
	return { common: COMMON_FILES, optional: OPTIONAL_FILES };
}

/**
 * Where one model file lands on disk, or null when the request is refused.
 *
 * MODEL-01 (2026-07-28 audit): modelId/file flow into BOTH the hub URL and the
 * on-disk path (join(store, modelId, file)). Reject traversal / URL-breaking
 * segments so a crafted id cannot write outside the store or rewrite the fetch
 * target, and confirm the resolved path stays under the store.
 */
export function resolveStoreTarget(modelId: string, file: string, store: string): string | null {
	if (!isSafeModelSegment(modelId) || !isSafeModelSegment(file)) return null;
	const target = join(store, modelId, file);
	const storeRoot = resolve(store);
	if (!resolve(target).startsWith(storeRoot + sep)) return null;
	return target;
}

/** Where a file is fetched FROM: the immutable revision, and (test seam) which hub. */
export interface FetchSource {
	/** A 40-hex hub commit sha. Anything else — `main` included — is refused. */
	revision: string;
	/** Defaults to HUB_BASE; a gate points it at a loopback fixture hub. */
	hubBase?: string;
}

/**
 * Resolve where one model file lands on disk AND where it comes from, or null
 * when the request is refused. The URL names the pinned REVISION, never a
 * branch: `…/resolve/<sha>/<file>` is content-addressed by the hub, so the
 * bytes a revision answers cannot move underneath an install. (CARRY-06: the
 * previous `/resolve/main/` fetched whatever the mutable head pointed at that
 * day, and the comment beside it claiming the hub ships no per-file hash was
 * measurably false.)
 */
export function resolveFetchTarget(
	modelId: string,
	file: string,
	store: string,
	source: FetchSource,
): { target: string; url: string } | null {
	const target = resolveStoreTarget(modelId, file, store);
	if (target === null) return null;
	if (!REVISION_HEX.test(source.revision)) return null;
	const hubBase = source.hubBase ?? HUB_BASE;
	return { target, url: `${hubBase}/${modelId}/resolve/${source.revision}/${file}` };
}

/**
 * True when a previous run already left this file COMPLETE on disk.
 *
 * `expected` is the authoritative byte length (the manifest's record, or the hub's
 * Content-Length). Without one — an air-gapped install, or a store seeded before
 * the manifest existed — the answer degrades to the old "non-empty" test, which is
 * the best a machine with no reference can honestly say. WITH one, a short file is
 * a partial download and must be re-fetched: accepting it is what shipped a
 * truncated model to the browser as "installed".
 */
export function isUsableCachedFile(target: string, expected?: number | null): boolean {
	if (!existsSync(target)) return false;
	const size = statSync(target).size;
	if (size === 0) return false;
	if (expected === undefined || expected === null) return true;
	return size === expected;
}

/**
 * How long a download may produce NOTHING before it is abandoned.
 *
 * Deliberately an idle bound rather than a total one: weights are gigabytes and a
 * heritage institution's uplink is not a data centre's, so any fixed ceiling would
 * eventually kill a healthy transfer. Silence is the thing that cannot be allowed
 * to last, because the lane it occupies is one of three the whole engine shares.
 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;

/**
 * The curl transport invocation.
 * -f: a 404 is a failure, not an HTML error page written to disk.
 * -L: follow the CDN redirect. -C -: resume a partial file.
 */
export function curlArgv(target: string, url: string, quiet: boolean): string[] {
	return [
		'curl',
		'-fL',
		'-C',
		'-',
		'--retry',
		'3',
		// AN IDLE BOUND, NOT A TOTAL ONE (CARRY-14). A model download is a
		// BACKGROUND JOB, and the engine has three background lanes shared by every
		// class of work; a hub that accepted the connection and then stalled held
		// one indefinitely, because this argv carried no time limit of any kind.
		// `--max-time` would be the wrong instrument: a multi-GB weights file
		// legitimately runs for hours on a museum's uplink. What must never be
		// unbounded is SILENCE — under 1 byte/s for this long and the transfer is
		// not slow, it is dead.
		'--speed-limit',
		'1',
		'--speed-time',
		String(Math.floor(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)),
		quiet ? '-sS' : '--progress-bar',
		'-o',
		target,
		url,
	];
}

/**
 * What one file is EXPECTED to be: the revision it is fetched at, the digest
 * and size it must hash to. Built by downloadModel from the pin table, so a
 * transport never decides for itself what it is allowed to accept.
 */
export interface FileExpectation {
	revision: string;
	hubBase: string;
	pin: FilePin;
}

/**
 * Fetch one file into the store. `true` = on disk and verified; `false` = not
 * obtained (absent upstream, transport failure); `'refused'` = obtained and
 * REJECTED on integrity grounds (quarantined) — a distinct answer, because the
 * remedy differs and the report must name the cause.
 */
export type FetchOutcome = boolean | 'refused';
export type FetchFile = (
	modelId: string,
	file: string,
	store: string,
	quiet: boolean,
	expect: FileExpectation,
) => Promise<FetchOutcome>;

export interface DownloadOptions {
	/** Target store root; defaults to the configured one. */
	store?: string;
	/** true = no terminal progress (the server path); false = curl's progress bar (the CLI). */
	quiet?: boolean;
	/** Called before each file starts (for logging/progress). */
	onFile?: (file: string) => void;
	/** Per-model-kind file lists: the non-weight files to fetch and which of
	 * the wanted files may 404 without failing the seed. Default: the KIND's
	 * entry in `commonFilesFor` (an explicit list overrides it). */
	commonFiles?: readonly string[];
	optionalFiles?: readonly string[];
	/**
	 * WHAT KIND of model this is — which decides the WEIGHT filenames when the
	 * catalog declares no `dtype`. A diarization model is `onnx/model.onnx`, not
	 * an encoder/decoder pair, so seeding a dtype-less speaker model as ASR asked
	 * the hub for two files that do not exist and never fetched the one that does.
	 */
	kind?: ModelKind;
	/**
	 * FETCH EXACTLY THESE FILES, instead of the computed set.
	 *
	 * The repair path's whole contract: re-fetch precisely what it removed. Left
	 * to `modelFiles(dtype)` a dtype-less repair deletes the q4 weights it found
	 * on disk and then downloads the fp32 set — deleting a 400 MB working install
	 * to replace it with ~3 GB the browser never asks for. Names come from the
	 * store's own evidence, so what comes back is what went away.
	 */
	files?: readonly string[];
	/** Transport seam: defaults to the real curl/fetch implementation. Injected
	 * by tests so the orchestration is drivable without the network. */
	fetchFile?: FetchFile;
	/**
	 * TEST SEAMS, never configuration: the pin table (defaults to the repo's
	 * `model_pins.json`) and the hub base URL (defaults to HUB_BASE). A gate pins
	 * a fixture model against a loopback hub; production never passes either.
	 */
	pins?: PinTable;
	hubBase?: string;
}

export interface DownloadReport {
	ok: boolean;
	/** Files now present (downloaded or already there). */
	files: string[];
	/** Optional files the model does not publish (informational). */
	skipped: string[];
	errors: string[];
	/**
	 * INTEGRITY refusals — a subset of `errors`, kept apart so a caller can name
	 * the cause (`ai.model_integrity`) instead of a generic failure: a model with
	 * no revision pin, a required file with no digest pin, or bytes that did not
	 * hash to the pin (quarantined).
	 */
	refused: string[];
}

/** Whether curl is on PATH (checked once per process). */
let curlChecked: boolean | null = null;
function haveCurl(): boolean {
	if (curlChecked === null) {
		try {
			curlChecked = Bun.spawnSync(['curl', '--version'], {
				stdout: 'ignore',
				stderr: 'ignore',
			}).success;
		} catch {
			// (!) A MISSING BINARY THROWS, it does not return `{success:false}`.
			// Measured: on a PATH without curl, `Bun.spawnSync(['curl','--version'])`
			// raises `Executable not found in $PATH: "curl"`. Unguarded, that escaped
			// `transport` → `fetchOneFile` → `downloadModel`, so the seed died before
			// a single byte — on exactly the curl-less host `plainFetch` exists to
			// serve. The fallback was correct and unreachable.
			curlChecked = false;
		}
	}
	return curlChecked;
}

/** One file's identity on disk: which model, which file, where the store put it. */
interface FileRef {
	store: string;
	modelId: string;
	file: string;
	target: string;
}

/**
 * The verdict on the file that is on disk NOW, against its pin: hash the bytes
 * (once — `verifiedDigest` caches by stat identity), and on a MATCH record size,
 * digest and revision in the manifest. On a MISMATCH the file is quarantined and
 * the manifest forgets it, so nothing downstream can mistake it for complete.
 *
 * Serves both the cached path (a store seeded before pins existed becomes
 * verified without a re-download) and the post-transport path.
 */
async function verifyAndRecord(ref: FileRef, expect: FileExpectation): Promise<FetchOutcome> {
	if (!existsSync(ref.target)) return false;
	const size = statSync(ref.target).size;
	// Shorter than the pin is a PARTIAL (the transport resumes it next time);
	// longer can never be, and a resume would only append to the wrong object.
	if (size < expect.pin.size) return false;
	const actual = size === expect.pin.size ? await verifiedDigest(ref.target) : null;
	if (actual !== expect.pin.sha256) {
		quarantineFile(ref.store, `${ref.modelId}/${ref.file}`);
		forgetFile(ref.store, ref.modelId, ref.file);
		return 'refused';
	}
	recordFileComplete(ref.store, ref.modelId, ref.file, expect.pin.size, {
		sha256: expect.pin.sha256,
		revision: expect.revision,
	});
	return true;
}

/**
 * The already-on-disk answer: a file whose manifest entry ALREADY carries the
 * pinned digest at the pinned size is accepted without re-hashing (the serving
 * door re-checks anyway); any other present file is hashed against the pin.
 */
async function acceptCached(ref: FileRef, expect: FileExpectation): Promise<FetchOutcome> {
	if (!isUsableCachedFile(ref.target, expect.pin.size)) return verifyAndRecord(ref, expect);
	const recorded = expectedDigest(ref.store, ref.modelId, ref.file);
	if (recorded === expect.pin.sha256) return true;
	return verifyAndRecord(ref, expect);
}

/**
 * curl transport. Async spawn: a server background job must never block the
 * event loop on a gigabyte download (spawnSync would freeze every request in
 * the process).
 */
async function curlFetch(target: string, url: string, quiet: boolean): Promise<boolean> {
	const proc = Bun.spawn(curlArgv(target, url, quiet), {
		stdout: quiet ? 'ignore' : 'inherit',
		stderr: quiet ? 'ignore' : 'inherit',
	});
	const code = await proc.exited;
	if (code === 0) return true;
	// curl leaves a zero-length file behind on a 404; it must not look cached.
	if (existsSync(target) && statSync(target).size === 0) rmSync(target);
	return false;
}

/**
 * WHAT ONE `fetch` ATTEMPT PRODUCED — four outcomes that are NOT
 * interchangeable. Only an ABORTED body can have left bytes on disk; a refusal
 * never opened the sink, and `unreachable` never got an answer at all.
 * Modelling this as a union instead of a boolean is what lets the decision be
 * taken ONCE, in `plainFetch`'s switch, rather than at every early return.
 */
type PlainFetchOutcome = 'complete' | 'refused' | 'aborted' | 'unreachable';

/**
 * An abort that fires after `ms` of SILENCE. `keepAlive()` restarts the clock —
 * a received byte is proof the transfer is alive — and `cancel()` stops it for
 * good, so a finished download leaves no timer behind.
 */
function idleAbort(ms: number): {
	signal: AbortSignal;
	keepAlive: () => void;
	cancel: () => void;
} {
	const controller = new AbortController();
	let timer = setTimeout(() => controller.abort(), ms);
	return {
		signal: controller.signal,
		keepAlive: (): void => {
			clearTimeout(timer);
			timer = setTimeout(() => controller.abort(), ms);
		},
		cancel: (): void => clearTimeout(timer),
	};
}

/**
 * Drain the body into the sink, one chunk at a time.
 *
 * (!) THE LOOP MUST BE ONE WE OWN, not `Bun.write(target, response)`.
 *
 * Measured (Bun 1.4.0, against a peer that sends headers plus one chunk and
 * then goes quiet): `controller.abort()` errors the response body, but a
 * `Bun.write` already awaiting that stream NEVER SETTLES — it hung >8s after a
 * 400ms abort. So the first version of this fix cancelled nothing and held the
 * lane exactly as long as before, with a timer for company. Reading the same
 * aborted body through a reader we drive ourselves rejects on schedule.
 */
async function pumpToWriter(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	writer: FileSink,
	keepAlive: () => void,
): Promise<void> {
	for (;;) {
		// rejects with the abort reason when the idle timer has fired
		const { done, value } = await reader.read();
		if (done) return;
		keepAlive();
		if (value) writer.write(value);
	}
}

/**
 * One attempt: fetch, then stream the body into `target`.
 *
 * (!) `fetch` ITSELF CAN REJECT, and that is the commonest stall shape, not an
 * exotic one. Measured (Bun 1.4.0): Bun resolves `fetch` on the FIRST BODY
 * BYTE, not on the headers — a peer that sends headers and then goes silent
 * without a single byte rejects at the `await fetch` line, OUTSIDE any reader
 * loop. That is precisely the hub-accepts-then-stalls case this whole fix
 * exists for, and leaving it to propagate broke `FetchFile`'s contract
 * (`false = not obtained`, never a throw): the seed died mid-run instead of
 * reporting one file missing. Connection refused and DNS failure — the ordinary
 * air-gapped and firewalled cases — arrive the same way.
 */
async function streamToFile(
	target: string,
	url: string,
	idle: { signal: AbortSignal; keepAlive: () => void },
): Promise<PlainFetchOutcome> {
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: 'follow', // the hub redirects to its CDN; curl follows too (-L)
			signal: idle.signal,
		});
	} catch {
		return 'unreachable';
	}
	if (!response.ok || response.body === null) {
		// Release the connection rather than leaving an unread body pinned open.
		await response.body?.cancel().catch(() => undefined);
		return 'refused';
	}

	const writer = Bun.file(target).writer();
	try {
		await pumpToWriter(response.body.getReader(), writer, idle.keepAlive);
		await writer.end();
		return 'complete';
	} catch {
		await writer.end();
		return 'aborted';
	}
}

/**
 * Transport fallback for hosts without curl.
 *
 * The bound is not optional here (CARRY-14). Model weights are fetched by a
 * BACKGROUND JOB, and the engine has three background lanes shared by every
 * class of work; a hub that accepts the connection and then stalls held one of
 * them for as long as it liked, with nothing to cancel it.
 *
 * It is an IDLE bound, not a total one: a multi-GB weights file legitimately
 * takes far longer than any fixed budget on a museum's uplink, so what must
 * never be unbounded is SILENCE.
 *
 * EXPORTED, with the bound as a defaulted parameter, for its gate. The invariant
 * here is behavioural — "a stalled peer stops holding the lane, and leaves
 * nothing on disk" — and a source-shape assertion was measured to be defeated by
 * renaming one local. Driving the real function against a LOOPBACK peer is
 * hermetic: it is the third-party hub that may not be reached from a test, not a
 * socket on this machine. The parameter exists because two minutes of silence is
 * the right production bound and an impossible test.
 */
export async function plainFetch(
	target: string,
	url: string,
	idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<boolean> {
	const idle = idleAbort(idleTimeoutMs);
	try {
		// Exhaustive over PlainFetchOutcome, in ONE place: a fourth outcome stops
		// compiling rather than falling through to an accidental `true`.
		switch (await streamToFile(target, url, idle)) {
			case 'complete':
				return true;
			case 'aborted':
				// A half-written file must not survive: `isUsableCachedFile` compares
				// against the manifest's expected size, but an ABANDONED download of a
				// file whose size was never learnt would otherwise sit there looking
				// complete, and the next run would accept it.
				if (existsSync(target)) rmSync(target);
				return false;
			case 'refused':
			case 'unreachable':
				// No usable response: the sink was never opened, so there is nothing
				// on disk to remove.
				return false;
		}
	} finally {
		idle.cancel();
	}
}

/**
 * The one transport door: curl when it exists, `fetch` otherwise.
 *
 * EXPORTED for its gate: `haveCurl()` is what decides here, and it is memoized
 * for the life of the process, so the only honest way to test the curl-less host
 * is a subprocess that reaches this door with curl absent from PATH.
 */
export function transport(target: string, url: string, quiet: boolean): Promise<boolean> {
	return haveCurl() ? curlFetch(target, url, quiet) : plainFetch(target, url);
}

/**
 * Download one file into the store unless it is already there, complete AND
 * matching its pin. Returns false when the file is absent upstream or its
 * bytes fail the digest (the caller decides whether absence is fatal — it is
 * not for OPTIONAL_FILES; a digest failure always is, and is quarantined).
 */
async function fetchOneFile(
	modelId: string,
	file: string,
	store: string,
	quiet: boolean,
	expect: FileExpectation,
): Promise<FetchOutcome> {
	const resolved = resolveFetchTarget(modelId, file, store, expect);
	if (resolved === null) return false;
	const { target, url } = resolved;
	const ref: FileRef = { store, modelId, file, target };

	// A cached file that FAILS its digest is quarantined and then re-fetched:
	// that is a repair, and the fresh bytes get their own verdict below.
	if ((await acceptCached(ref, expect)) === true) return true;

	mkdirSync(dirname(target), { recursive: true });
	// The transport may have resumed into a stale partial: forget any verdict
	// cached for the old bytes before the post-transport hash.
	forgetVerdict(target);
	if (!(await transport(target, url, quiet))) return false;
	return verifyAndRecord(ref, expect);
}

/** Every default `DownloadOptions` leaves open, resolved once. */
interface DownloadPlan {
	store: string;
	quiet: boolean;
	/** The files to fetch, deduplicated. */
	wanted: string[];
	/** Of those, the ones a 404 may not fail. */
	optional: readonly string[];
	fetchFile: FetchFile;
	pins: PinTable | undefined;
	hubBase: string;
}

/**
 * Which files this download is for. An explicit list is the WHOLE plan (the
 * repair path re-fetches exactly what it removed); otherwise modelFiles carries
 * config.json + the weights and the common files union in.
 */
function wantedFiles(
	modelId: string,
	dtype: ModelDtype | undefined,
	options: DownloadOptions,
): string[] {
	if (options.files !== undefined) return [...new Set(options.files)];
	const kind = options.kind ?? 'asr';
	// Each weight's external-data chunks ride with it, as the PIN names them
	// (no pin, no download — so the pin is always there to ask).
	const weights = withExternalData(
		modelId,
		modelFiles(dtype, kind),
		options.pins ?? readPinTable(),
	);
	return [...new Set([...(options.commonFiles ?? commonFilesFor(kind).common), ...weights])];
}

/** How the files are obtained: the transport and the hub it asks (defaults: curl, the hub). */
function downloadTransport(
	options: DownloadOptions,
): Pick<DownloadPlan, 'fetchFile' | 'pins' | 'hubBase'> {
	return {
		fetchFile: options.fetchFile ?? fetchOneFile,
		pins: options.pins,
		hubBase: options.hubBase ?? HUB_BASE,
	};
}

function planDownload(
	modelId: string,
	dtype: ModelDtype | undefined,
	options: DownloadOptions,
): DownloadPlan {
	return {
		store: options.store ?? modelStoreRoot(),
		quiet: options.quiet ?? true,
		wanted: wantedFiles(modelId, dtype, options),
		optional: options.optionalFiles ?? commonFilesFor(options.kind ?? 'asr').optional,
		...downloadTransport(options),
	};
}

/**
 * The integrity verdict on one obtained file, INDEPENDENT of the transport.
 * fetchOneFile already verifies and records on its own path (its manifest entry
 * then carries the pinned digest, so this re-check costs a manifest read, not a
 * second hash); an injected transport (tests, or a future non-curl transport)
 * is held to the same pin here, so no transport can hand the store unverified
 * bytes. False = refused (quarantined, manifest forgotten).
 */
async function verifyObtained(
	store: string,
	modelId: string,
	file: string,
	expect: FileExpectation,
): Promise<FetchOutcome> {
	const target = resolveStoreTarget(modelId, file, store);
	if (target === null || !existsSync(target)) return true; // nothing landed; the transport's own verdict stands
	return acceptCached({ store, modelId, file, target }, expect);
}

/**
 * A model with no weights is a FAILED seed, never a quiet success: the browser
 * would fail at transcription time, the surprise the store exists to prevent.
 * Only when weights were ASKED FOR, though — a repair that re-fetches one corrupt
 * tokenizer.json is complete without touching the weights, and calling that a
 * failure would report a successful repair as broken.
 */
function weightsMissing(wanted: readonly string[], gotWeights: boolean): boolean {
	return !gotWeights && wanted.some((file) => file.endsWith('.onnx'));
}

/**
 * Download everything one catalog entry needs: the common files plus the ONNX
 * weights for the quantisation the catalog declares (`dtype` — absent means the
 * repo's plain fp32 files). Idempotent: present files are kept, so re-running
 * completes an interrupted download.
 */
export async function downloadModel(
	modelId: string,
	dtype: ModelDtype | undefined,
	options: DownloadOptions = {},
): Promise<DownloadReport> {
	const plan = planDownload(modelId, dtype, options);
	const report: DownloadReport = { ok: false, files: [], skipped: [], errors: [], refused: [] };

	// NO PIN, NO BYTE. The hub's `main` is a mutable head; without an immutable
	// revision and per-file digests there is nothing to verify a download
	// against, so the engine does not make it (the operator pins the model with
	// scripts/pin_ai_models.ts, or seeds the store by rsync and owns the bytes).
	const revision = pinnedRevision(modelId, plan.pins);
	if (revision === null) {
		refuse(
			report,
			`${modelId}: no revision pin in model_pins.json — refusing to fetch from a mutable hub head`,
		);
		return report;
	}

	mkdirSync(plan.store, { recursive: true });

	for (const file of plan.wanted) {
		options.onFile?.(file);
		await obtainOne(modelId, file, revision, plan, report);
	}

	if (
		weightsMissing(
			plan.wanted,
			report.files.some((file) => file.endsWith('.onnx')),
		)
	) {
		report.errors.push(`${modelId}: no ONNX weights were obtained`);
	}

	report.ok = report.errors.length === 0;
	return report;
}

/** An integrity refusal is an error that also names its cause. */
function refuse(report: DownloadReport, why: string): void {
	report.refused.push(why);
	report.errors.push(why);
}

/**
 * One file, start to finish: pin lookup, transport, the integrity verdict, and
 * the report line it earns. A file is either obtained AND verified, skipped
 * (optional, unpublished or unpinned), refused (integrity) or failed (transport).
 */
async function obtainOne(
	modelId: string,
	file: string,
	revision: string,
	plan: DownloadPlan,
	report: DownloadReport,
): Promise<void> {
	const pin = pinFor(modelId, file, plan.pins);
	if (pin === null) {
		// The pin generator records every wanted file the repository PUBLISHES
		// at the revision; an optional file without a pin is one it does not.
		if (plan.optional.includes(file)) report.skipped.push(file);
		else
			refuse(
				report,
				`${file}: no digest pin for ${modelId} — refusing to fetch an unverifiable file`,
			);
		return;
	}
	const expect: FileExpectation = { revision, hubBase: plan.hubBase, pin };
	const outcome = await plan.fetchFile(modelId, file, plan.store, plan.quiet, expect);
	const verdict =
		outcome === true ? await verifyObtained(plan.store, modelId, file, expect) : outcome;
	recordVerdict(modelId, file, verdict, plan, report);
}

/** The report line one file's verdict earns. */
function recordVerdict(
	modelId: string,
	file: string,
	verdict: FetchOutcome,
	plan: DownloadPlan,
	report: DownloadReport,
): void {
	if (verdict === 'refused') {
		refuse(report, `${file}: bytes do not match the pinned sha256 for ${modelId} — quarantined`);
	} else if (verdict === true) {
		report.files.push(file);
	} else if (plan.optional.includes(file)) {
		report.skipped.push(file);
	} else {
		report.errors.push(`${file}: download failed from ${plan.hubBase}/${modelId}`);
	}
}
