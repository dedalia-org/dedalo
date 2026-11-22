/**
 * Remote ASR seam (PHP tool_transcription::automatic_transcription /
 * ::check_server_transcriber_status + transcribers/babel/class.babel_transcriber.php).
 * The REMOTE alternative to the browser-Whisper flow: submit the record's audio
 * URL to an external transcriber server, which returns a job PID and processes
 * asynchronously. Completion is handled two ways, matching PHP:
 *  - the CLIENT polls check_server_transcriber_status (delete_result=false,
 *    non-destructive);
 *  - the SERVER runs a detached background poll (PHP
 *    exec_background_check_transcription → check_background_transcriber_status)
 *    that, on Babel status 3, converts the segments to TC-tagged text and saves
 *    them into the transcription component (process_file).
 *
 * The transcriber is a PROVIDER seam: the real babel providers POST to the
 * configured server (external, ledgered); tests inject stubs. Background
 * identity/lang are CAPTURED AT ENQUEUE TIME and threaded explicitly through
 * the job payload — nothing here reads the ALS stores (isolation Rule 6).
 */

import { segments_to_html as segmentsToHtml } from '../../../tools/tool_transcription/transcribers/lib/paragraphs.js';
import { DedaloError } from '../errors/index.ts';
import type { Principal } from '../security/permissions.ts';
// The ONE transcript formatter, shared verbatim with the browser engine (plain
// ESM, no build step — see segmentsToTcText).
import { fetchGuardedText, isSsrfRefusal } from '../security/ssrf_guard.ts';
import { authorizeRecordAccess } from '../security/write_door.ts';
import { localAsrProvider, localAsrStatusProvider } from './transcription_local_asr.ts';

/**
 * The engine name of the institution's own on-premise recognition box. One
 * constant, because it is matched in three places (submit, status, and the tool
 * handler that has to hand it a file path instead of a URL).
 */
export const LOCAL_ASR_ENGINE = 'local_whisper';

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Submit (PHP babel_transcriber::transcribe)
// ---------------------------------------------------------------------------

export interface TranscribeRequest {
	uri: string;
	key: string;
	/** Engine name as POSTed to babel — already mapped through mapTranscriberEngine. */
	engine: string;
	quality: string;
	/** Full fetchable URL of the 'audio' quality file (PHP av_url). */
	audioUrl: string;
	/**
	 * Absolute path of the audio ON THIS SERVER'S disk. Used only by the
	 * on-premise engine, which is POSTed the bytes instead of a URL: a sidecar on
	 * the LAN cannot fetch a public media URL, and publishing one would defeat the
	 * point of keeping the recording inside the building.
	 */
	audioPath?: string;
	/** ISO 639-1 code (PHP lang_tld2 — babel wants alpha-2, not lg-*). */
	langTld2: string;
	userId: number;
	entityName: string;
}

/**
 * One submit call's outcome — an INTERNAL provider protocol, never a wire body.
 * Discriminated on `ok` so nothing envelope-shaped can escape a transcriber
 * (the tool handler turns it into its own response).
 */
export type TranscribeResult =
	| { ok: true /** The transcriber server's job handle. */; pid: string | number; msg: string }
	| { ok: false; msg: string };

export type TranscriberProvider = (req: TranscribeRequest) => Promise<TranscribeResult>;

/**
 * Real babel transcriber — submits the audio URL, returns the server job PID.
 * Field names + method_name mirror PHP babel_transcriber::transcribe exactly;
 * babel answers { result: { pid } } (PHP reads $transcriber_response->result->pid).
 */
export const babelTranscriberProvider: TranscriberProvider = async (req) => {
	try {
		// ONE GUARD, ONE TRANSPORT (CARRY-10 / CARRY-14). This carried a private
		// COPY of the translator's four-string blocklist — the file said so — and
		// the fetch had no signal, no timeout and no byte cap. `fetchGuardedText`
		// resolves the host and vets the addresses, refuses redirects, and bounds
		// both the wait and the read.
		const rawBody = await fetchGuardedText(req.uri, {
			maxBytes: 8 * 1024 * 1024,
			init: {
				method: 'POST',
				body: new URLSearchParams({
					key: req.key,
					engine: req.engine,
					quality: req.quality,
					user_id: String(req.userId),
					entity_name: req.entityName,
					lang_tld2: req.langTld2,
					av_url: req.audioUrl,
					method_name: 'transcribe',
				}),
			},
		});
		// No status branch here any more: fetchGuardedText THROWS on a non-2xx
		// (`HTTP <status>`), so a transcriber error lands in the catch below
		// instead of being tested for a second time on a hand-made response.
		// `body.result` here is BABEL'S OWN wire shape (an external service's
		// contract), not a Dédalo envelope — it is read, never produced.
		const body = JSON.parse(rawBody) as { result?: { pid?: string | number } | false };
		const pid = body.result !== false && body.result !== undefined ? body.result.pid : undefined;
		if (pid === undefined || pid === null) {
			return { ok: false, msg: 'transcriber returned no pid' };
		}
		return { ok: true, pid, msg: 'ok' };
	} catch (error) {
		// The guard's own text names the address it refused — an oracle on the
		// wire, and not the `msg` this door has always published.
		const msg = isSsrfRefusal(error) ? 'invalid transcriber URL' : (error as Error).message;
		return { ok: false, msg };
	}
};

/** PHP switch fall-through: engine 'local' is served by babel_transcriber. */
export function mapTranscriberEngine(engine: string): string {
	return engine === 'local' ? 'babel_transcriber' : engine;
}

/** Resolve a transcriber provider by engine name (PHP transcriber switch). */
export function resolveTranscriberProvider(engine: string): {
	provider: TranscriberProvider | null;
	error: string | null;
} {
	switch (engine) {
		// The institution's OWN recognition box (src/core/tools/transcription_local_asr.ts):
		// audio POSTed as bytes, private addresses allowed behind a named exemption.
		case LOCAL_ASR_ENGINE:
			return { provider: localAsrProvider, error: null };
		case 'local': // PHP fall-through: local → babel_transcriber
		case 'babel_transcriber':
		case '':
		case undefined as unknown as string:
			return { provider: babelTranscriberProvider, error: null };
		default:
			return { provider: null, error: `Sorry. '${engine}' is not implemented yet` };
	}
}

/**
 * Resolve the {uri, key} for a transcriber engine from tool config (dd996).
 *
 * `getToolConfig` returns the tool's config already RESOLVED per key — the
 * effective value under the option name, with any `{value, client, …}` wrapper
 * unwrapped. So the entry list is `toolConfig.transcriber_config` (an array).
 * The nested `config.transcriber_config.value` form is PHP's raw config-item
 * shape (`tool_common::get_config` returns the whole item, and the PHP tool then
 * read `->config->…` off an ARRAY — which yielded null, so the PHP remote path
 * never resolved a uri/key either). Both are accepted; the flat one is the shape
 * this engine actually produces.
 */
export function resolveTranscriberConfig(
	toolConfig: Record<string, unknown>,
	engine: string,
): { uri: string; key: string } | null {
	// `getToolConfig` returns the EFFECTIVE config: a flat map of key → resolved
	// value, so `transcriber_config` is already the array of entries. This used to
	// read `toolConfig.config.transcriber_config.value` — a shape getToolConfig
	// never produces — so every lookup returned null and no server-side engine
	// could ever find its uri/key ("Transcriber config is not defined for '…'").
	// Its test passed because the fixture was written to the same wrong shape.
	// The nested form is still accepted: an install that stores the raw property
	// object (rather than the resolved value) reads the same either way.
	const flat = toolConfig?.transcriber_config;
	const nested = (toolConfig?.config as { transcriber_config?: { value?: unknown[] } } | undefined)
		?.transcriber_config?.value;
	const wrapped = (toolConfig?.transcriber_config as { value?: unknown[] } | undefined)?.value;
	const configs = Array.isArray(flat) ? flat : Array.isArray(wrapped) ? wrapped : nested;
	if (!Array.isArray(configs)) return null;
	const entry = configs.find(
		(item) =>
			item !== null && typeof item === 'object' && (item as { name?: string }).name === engine,
	) as { uri?: string; key?: string } | undefined;
	if (!entry?.uri || !entry.key) return null;
	return { uri: entry.uri, key: entry.key };
}

// ---------------------------------------------------------------------------
// Status poll (PHP babel_transcriber::check_transcriber_status)
// ---------------------------------------------------------------------------

export interface TranscriberStatusRequest {
	/** The transcriber server endpoint (also POSTed as the 'url' field — PHP does the same). */
	uri: string;
	key: string;
	/**
	 * The PUBLISHED audio URL, which must match the one submitted at transcribe
	 * time byte-for-byte (babel keys the job by it).
	 *
	 * NULLABLE, and required to be stated: the on-premise engine has none, and
	 * must not — its sidecar was POSTed the audio BYTES precisely so no recording
	 * is ever published (engineering/TRANSCRIPTION.md). `null` is the caller
	 * SAYING there is no published URL, which is different from forgetting one;
	 * `statusPollNeedsExternalAudioUrl` decides which engines may say it, and
	 * passing null for an engine that needs one throws.
	 */
	avUrl: string | null;
	/** Engine name as POSTed — already mapped through mapTranscriberEngine. */
	engine: string;
	userId: number;
	entityName: string;
	pid: string | number;
	/** false = client poll (non-destructive); true = server poll (babel cleans up on status 3). */
	deleteResult: boolean;
	/** Dédalo lang (lg-*) — present on the background path only (PHP params descriptor). */
	lang?: string | null;
}

/**
 * A status provider returns the DECODED INNER `result` of babel's response
 * (PHP check_transcriber_status returns $response->result): typically
 * { status: 1|2|3, transcription_data? }. A provider-side failure returns
 * `{ ok:false, msg }` — an INTERNAL shape, never an envelope.
 */
export type TranscriberStatusProvider = (req: TranscriberStatusRequest) => Promise<unknown>;

/**
 * Whether a status poll for this engine needs the PUBLISHED external audio URL.
 *
 * Only the EXTERNAL (babel-family) transcribers do: they were handed a fetchable
 * URL at submit time and key the running job by it, so the poll must rebuild the
 * same string. The on-premise engine was handed the audio BYTES and keys its job
 * by its own id — asking the media layer for a published URL there is not merely
 * unnecessary, it is the one thing engineering/TRANSCRIPTION.md forbids
 * ("on-premise inference must never require publishing the audio").
 *
 * This used to be nobody's decision, so `check_server_transcriber_status` built
 * the URL for every engine and an on-premise poll died with a
 * DEDALO_MEDIA_EXPORT_BASE configuration error — the client stopped polling and
 * left the button disabled with a live pid (audit 2026-08 §5.6).
 *
 * THE CLIENT POLL CONSULTS IT (fixed 2026-08-09).
 * `tools/tool_transcription/server/index.ts` (checkServerTranscriberStatus) used
 * to call `externalMediaUrl(audioRel)` unconditionally, before any provider was
 * chosen; it now routes through that file's `statusPollAvUrl`, which is this
 * decision plus the URL builder.
 *
 * Gates: test/unit/transcription_status_poll_native.test.ts (this decision and
 * the provider routing) + test/unit/transcription_client_poll_av_url_native.test.ts
 * (the seam AND the handler itself — the latter runs
 * `checkServerTranscriberStatus` with a capturing provider and asserts the
 * observed av_url, because pinning a helper never proves the call site still
 * calls it).
 */
export function statusPollNeedsExternalAudioUrl(engine: string): boolean {
	return engine !== LOCAL_ASR_ENGINE;
}

/**
 * The exact POST body of a babel check_status call (pure — unit-testable).
 *
 * Reached only by the BABEL-FAMILY providers: the on-premise engine has its own
 * status provider (`GET jobs/<id>`) and never builds this form. The engine test
 * is kept all the same, because `resolveTranscriberStatusProvider` routes every
 * UNKNOWN engine here by default — so an engine added tomorrow that keys its job
 * by something other than a published URL gets a body without one instead of the
 * string "undefined".
 */
export function buildTranscriberStatusBody(req: TranscriberStatusRequest): URLSearchParams {
	const needsAudioUrl = statusPollNeedsExternalAudioUrl(req.engine);
	if (needsAudioUrl && (req.avUrl === null || req.avUrl === '')) {
		// Fail LOUDLY: this used to POST the literal string "undefined", so babel
		// answered about a job that did not exist and the client polled a handle
		// that could never complete. Thrown, not enveloped — see
		// babelTranscriberStatusProvider.
		throw new DedaloError('request.invalid_data', {
			message: `buildTranscriberStatusBody: engine '${req.engine}' keys its job by av_url, but none was supplied — the poll cannot identify the job`,
			coordinates: { engine: req.engine },
		});
	}
	// Field ORDER is kept exactly as PHP sent it (key, url, av_url, engine, …).
	const fields: Record<string, string> = { key: req.key, url: req.uri };
	if (needsAudioUrl && req.avUrl !== null) fields.av_url = req.avUrl;
	Object.assign(fields, {
		engine: req.engine,
		method_name: 'check_status',
		user_id: String(req.userId),
		entity_name: req.entityName,
		pid: String(req.pid),
		delete_result: req.deleteResult ? 'true' : 'false',
	});
	const body = new URLSearchParams(fields);
	if (req.lang != null && req.lang !== '') body.set('lang', req.lang);
	return body;
}

/** Real babel status poll — POSTs check_status, returns the decoded inner result. */
export const babelTranscriberStatusProvider: TranscriberStatusProvider = async (req) => {
	// The body is built OUTSIDE the try on purpose. `{ok:false, msg}` is the
	// vocabulary for "the transcriber said no / is unreachable"; a caller that
	// did not supply the av_url the job is keyed by is a PROGRAMMING error, and
	// laundering it into that envelope hid the real message behind the poll's
	// generic "status not valid" report.
	const requestBody = buildTranscriberStatusBody(req);
	try {
		// Same one guard, same one transport (CARRY-10 / CARRY-14).
		const rawBody = await fetchGuardedText(req.uri, {
			maxBytes: 8 * 1024 * 1024,
			init: { method: 'POST', body: requestBody },
		});
		// Babel's own envelope again — decoded, never produced.
		const body = JSON.parse(rawBody) as { result?: unknown };
		return body.result ?? null;
	} catch (error) {
		// The guard's own text names the address it refused — an oracle on the
		// wire, and not the `msg` this door has always published.
		const msg = isSsrfRefusal(error) ? 'invalid transcriber URL' : (error as Error).message;
		return { ok: false, msg };
	}
};

/**
 * Resolve a STATUS provider by engine name. Mirrors the PHP
 * check_server_transcriber_status switch: google_translation is not
 * implemented; 'local' falls through to babel; unknown engines default to
 * babel (PHP `case 'babel_transcriber': default:`).
 */
export function resolveTranscriberStatusProvider(engine: string): {
	provider: TranscriberStatusProvider | null;
	error: string | null;
} {
	switch (engine) {
		case LOCAL_ASR_ENGINE:
			return { provider: localAsrStatusProvider, error: null };
		case 'google_translation':
			return { provider: null, error: `Sorry. '${engine}' is not implemented yet` };
		default:
			return { provider: babelTranscriberStatusProvider, error: null };
	}
}

// ---------------------------------------------------------------------------
// Write-back (PHP babel_transcriber::process_file)
// ---------------------------------------------------------------------------

/** One transcription segment. `end`/`speaker` are absent from older providers. */
export interface TranscriptionSegment {
	start: number;
	text: string;
	end?: number | null;
	speaker?: string;
}

/**
 * Segment formatting — the SAME grouping the browser engine applies, because it
 * is literally the same module: `transcribers/lib/paragraphs.js` is plain ESM and
 * Bun imports it directly. A transcript produced on the server and one produced in
 * the browser must land in the record with identical structure; two
 * implementations would drift the first time either was tuned.
 *
 * A recogniser emits subtitle-sized segments. Writing each of them as its own
 * paragraph (which is what this function used to do — one `[TC_…_TC]` per
 * segment, joined by `<p>`) destroys the paragraph structure an interview
 * transcript depends on. Segments are now grouped at pauses, speaker changes and
 * sentence ends, with inline time marks kept inside each paragraph so the
 * subtitle builder still has anchors to interpolate between.
 *
 * @param segments recogniser output, times in seconds
 * @param options paragraph/timecode options (see the module's DEFAULT_OPTIONS)
 */
export function segmentsToTcText(
	segments: readonly TranscriptionSegment[],
	options?: Record<string, unknown>,
): string {
	return segmentsToHtml(segments, options);
}

/** The target transcription component locator (PHP transcription_ddo). */
export interface TranscriptionDdo {
	component_tipo: string;
	section_tipo: string;
	section_id: number;
}

/**
 * PHP process_file guard: the target component's existing data in the target
 * lang is NEVER overwritten — the user must delete it before re-transcribing.
 * (PHP checks !empty($current_data[0]); any object item is non-empty in PHP,
 * so ANY item in the lang slice blocks the save.)
 */
export function hasExistingTranscription(items: readonly unknown[], lang: string): boolean {
	return items.some(
		(item) =>
			item !== null && typeof item === 'object' && (item as { lang?: string }).lang === lang,
	);
}

/**
 * PHP babel_transcriber::process_file — convert babel segments to TC-tagged
 * text and persist it into the transcription component through the tx+TM save
 * chokepoint (saveComponentData). Identity arrives EXPLICITLY (userId) — never
 * from ALS (this runs in a detached background job).
 *
 * NOTE (PHP divergence, deliberate): PHP passes a raw STRING to the
 * array-typed component_common::set_data_lang (a latent TypeError). We write
 * the intended shape — one { value, lang } item in the target lang slice.
 *
 * ITS OWN WRITE DOOR (T2-S05-a). The writer takes the writing PRINCIPAL —
 * required, no default — and asks authorizeRecordAccess (write, level 2,
 * section floor 1, the dd128-aware pair, the write scope) BEFORE anything is
 * read or written; the save addresses the GRANT's coordinates and actor, never
 * the raw ddo. It used to check nothing itself and trust its one caller's save
 * seam, so any future importer would have written ungated (the dd128 census
 * held it PENDING). A refusal THROWS the door's typed error — the caller (the
 * background poll's save seam) turns it into the job's terminal state.
 */
export async function saveTranscriptionResult(
	input: TranscriptionSaveInput,
): Promise<TranscriptionSaveOutcome> {
	const { lang, transcriptionDdo, segments, principal } = input;
	const grant = await authorizeRecordAccess(
		principal,
		{
			section_tipo: transcriptionDdo.section_tipo,
			component_tipo: transcriptionDdo.component_tipo,
			section_id: transcriptionDdo.section_id,
		},
		{ mode: 'write', level: 2, sectionFloor: 1, door: input.door ?? TRANSCRIPT_WRITE_DOOR },
	);
	if (!Array.isArray(segments) || segments.length === 0) {
		return { saved: false, msg: 'transcription has no segments — nothing to save' };
	}
	const data = segmentsToTcText(segments);

	const { getModelByTipo, getMatrixTableFromTipo } = await import('../ontology/resolver.ts');
	const { readMatrixRecord } = await import('../db/matrix.ts');
	const { readComponentItems } = await import('../resolve/component_data.ts');

	const model = await getModelByTipo(grant.componentTipo);
	if (model === null) {
		return { saved: false, msg: `unknown component tipo '${grant.componentTipo}'` };
	}
	const table = await getMatrixTableFromTipo(grant.sectionTipo);
	if (table === null) {
		return { saved: false, msg: `no matrix table for section '${grant.sectionTipo}'` };
	}
	const record = await readMatrixRecord(table, grant.sectionTipo, grant.sectionId);
	const items =
		record !== null ? (readComponentItems(record, grant.componentTipo, model) ?? []) : [];
	if (hasExistingTranscription(items, lang)) {
		return {
			saved: false,
			msg: 'component already has data — skipped (delete the existing data to re-transcribe)',
		};
	}

	const { saveComponentData } = await import('../section/record/save_component.ts');
	const result = await saveComponentData({
		componentTipo: grant.componentTipo,
		sectionTipo: grant.sectionTipo,
		sectionId: grant.sectionId,
		lang,
		// THE transcription is the lang's single main text: always item id 1,
		// stated explicitly. An id-less update relies on slice/sibling resolution
		// and APPENDS with a minted id when nothing resolves — which is how a
		// finished transcription ended up invisible in item 2 while the editor
		// showed the empty item 1 (rsc167/528, 2026-07-28). Same contract as the
		// browser tool's save_transcription.
		changedData: [{ action: 'update', id: 1, key: 0, value: { id: 1, value: data, lang } }],
		userId: grant.userId,
	});
	return {
		saved: result.ok,
		msg: result.ok ? 'OK. Transcription saved' : result.message,
	};
}

/** The write door's name for a transcript written by this module (the grant's `door`). */
export const TRANSCRIPT_WRITE_DOOR = 'transcription_asr.save_result';

/** What a transcript save did: written, or why not (a message, never a throw past the door). */
export interface TranscriptionSaveOutcome {
	saved: boolean;
	msg: string;
}

/** What the poll hands its save: the job's captured coordinates and actor id. */
export interface TranscriptionPollSave {
	lang: string;
	transcriptionDdo: TranscriptionDdo;
	segments: readonly TranscriptionSegment[];
	userId: number;
}

/** The writer's input: the poll's save plus the PRINCIPAL the write door judges. */
export interface TranscriptionSaveInput extends Omit<TranscriptionPollSave, 'userId'> {
	principal: Principal;
	/** The calling door's name for the grant/log line (default TRANSCRIPT_WRITE_DOOR). */
	door?: string;
}

// ---------------------------------------------------------------------------
// Background completion poll (PHP check_background_transcriber_status)
// ---------------------------------------------------------------------------

/** Everything a detached poll needs — captured at ENQUEUE time (no ALS reads). */
export interface TranscriptionPollJob {
	/** The status request minus deleteResult (the poll sets true — PHP background rule). */
	status: Omit<TranscriberStatusRequest, 'deleteResult'>;
	/** Dédalo lang the transcript is written into (the audio's source lang). */
	lang: string;
	transcriptionDdo: TranscriptionDdo;
	userId: number;
}

export interface TranscriptionPollOptions {
	/**
	 * Override the status provider. Left unset (the production path), the provider
	 * is resolved FROM THE JOB'S ENGINE — see pollTranscriptionCompletion.
	 */
	provider?: TranscriberStatusProvider;
	/**
	 * The save — REQUIRED, with no default: the job carries a user ID, never a
	 * principal, and only the caller can resolve one that is still LIVE when the
	 * job finishes (tool_transcription resolves it, then hands it to
	 * saveTranscriptionResult, which asks the write door itself).
	 */
	save: (input: TranscriptionPollSave) => Promise<TranscriptionSaveOutcome>;
	/** PHP recurses forever every 4 s; we BOUND the loop (default ~30 min). */
	maxAttempts?: number;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll babel until the job completes, then persist the transcript
 * (PHP check_background_transcriber_status). Status semantics:
 *   1 → no pid / no result file on the server: terminal, nothing to do;
 *   2 → still processing: sleep (PHP sleep(4)) and poll again;
 *   3 → done: process_file-equivalent save (guarded against overwrite).
 * Bounded: after maxAttempts the poll gives up LOUDLY (console.error + a
 * failed job record) — it never throws into the server.
 *
 * THE PROVIDER FOLLOWS THE ENGINE (audit 2026-08 §5.6). This defaulted to
 * `babelTranscriberStatusProvider` for every job, whatever engine had produced
 * it. The engine picks the SUBMIT provider (resolveTranscriberProvider), so a
 * `local_whisper` job was submitted to the on-premise sidecar and then polled by
 * POSTing babel's `check_status` form at it — a sidecar whose only status
 * endpoint is `GET jobs/<id>`. The job therefore never reported done and the
 * transcript was never written back: on-premise recognition could not complete on
 * the server side at all. Same engine, same routing table, both directions.
 */
/*
 * COVERAGE-EXEMPT — the PROVIDER CALL below (coverage plan §5.2; reason
 * registered in engineering/crap_coverage_exempt.json): it posts to a
 * third-party / sidecar service over the network. Never fetch in a test — a gate
 * would be non-hermetic and hostage to someone else's uptime. The pure halves in
 * these files (engine mapping, config resolution, URL safety, segment folding)
 * ARE gateable and are not covered by this exemption.
 */
export async function pollTranscriptionCompletion(
	job: TranscriptionPollJob,
	opts: TranscriptionPollOptions,
): Promise<{ ok: boolean; msg: string }> {
	const resolved = resolveTranscriberStatusProvider(job.status.engine);
	const provider = opts.provider ?? resolved.provider;
	if (provider === null || provider === undefined) {
		// Never fall back to babel for an engine the routing table refuses: that is
		// how a job gets polled by a protocol its server does not speak.
		const msg =
			resolved.error ?? `no status provider for transcriber engine '${job.status.engine}'`;
		console.error(`[tool_transcription] ${msg} (pid ${job.status.pid})`);
		return { ok: false, msg };
	}
	const save = opts.save;
	const maxAttempts = opts.maxAttempts ?? 450;
	const intervalMs = opts.intervalMs ?? 4000;
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		// delete_result=true: only the server-side poll may let babel clean up
		// the finished result (PHP check_background_transcriber_status).
		const status = await provider({ ...job.status, deleteResult: true });
		const statusCode =
			status !== null && typeof status === 'object'
				? Number((status as { status?: unknown }).status)
				: Number.NaN;

		if (statusCode === 2) {
			await sleep(intervalMs);
			continue;
		}
		if (statusCode === 1) {
			return { ok: false, msg: 'Babel: no pid, no file to get data (status 1)' };
		}
		if (statusCode === 3) {
			const data = (status as { transcription_data?: { segments?: TranscriptionSegment[] } })
				.transcription_data;
			// NARROW THE REMOTE SEGMENTS TO THE DECLARED SHAPE — do not pass the
			// transcriber's JSON through verbatim.
			//
			// `TranscriptionSegment` declares four fields and TypeScript strips none
			// of them at runtime, so whatever extra keys the remote service put on a
			// segment travelled all the way into the stored value. That mattered on
			// 2026-08-30, when the paragraph rebuild grew an `html` FIDELITY OVERRIDE
			// that emits its string unescaped: a hostile or compromised transcriber
			// could answer `{text:'hola', html:'<img src=x onerror=…>'}` and have the
			// tag stored in a heritage record. The override is a Symbol now, which
			// JSON cannot carry, so that specific hole is closed at the other end too
			// — this is the boundary half, and it is the one that also covers the
			// next unescaped channel somebody adds without thinking about this seam.
			const segments: TranscriptionSegment[] = (Array.isArray(data?.segments) ? data.segments : [])
				.filter((segment): segment is TranscriptionSegment => typeof segment?.text === 'string')
				.map((segment) => ({
					text: segment.text,
					start: typeof segment.start === 'number' ? segment.start : 0,
					end: typeof segment.end === 'number' ? segment.end : null,
					...(typeof segment.speaker === 'string' ? { speaker: segment.speaker } : {}),
				}));
			const outcome = await save({
				lang: job.lang,
				transcriptionDdo: job.transcriptionDdo,
				segments,
				userId: job.userId,
			});
			return { ok: outcome.saved, msg: outcome.msg };
		}
		const detail =
			status !== null && typeof status === 'object'
				? JSON.stringify(status).slice(0, 256)
				: String(status);
		return { ok: false, msg: `Error. status not valid: ${detail}` };
	}

	console.error(
		`[tool_transcription] gave up polling babel pid ${job.status.pid} after ${maxAttempts} attempts (the job may still be running on the transcriber server; the client can keep polling via check_server_transcriber_status)`,
	);
	return {
		ok: false,
		msg: `gave up after ${maxAttempts} poll attempts (pid ${job.status.pid})`,
	};
}
