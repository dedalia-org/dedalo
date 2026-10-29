/**
 * tool_transcription server module (PHP tool_transcription) — full surface.
 *
 * LOCAL half (browser-Whisper flow):
 *   create_transcribable_audio_file: build (idempotently) the audio_tr WAV from
 *     the AV original and return its fetchable media URL — the browser Whisper
 *     worker fetches that URL and transcribes client-side.
 *   delete_transcribable_audio_file: hard-delete that throwaway WAV (idempotent).
 *
 * REMOTE half (external ASR seam):
 *   automatic_transcription: ensure the 'audio' quality, submit its URL to the
 *     configured transcriber server (job PID returned), then detach a bounded
 *     background poll (PHP exec_background_check_transcription) that writes the
 *     transcript back on completion.
 *   check_server_transcriber_status: the CLIENT's non-destructive poll of a
 *     running job (delete_result=false) — of ITS OWN job only: the `pid` it
 *     accepts is the sealed poll handle automatic_transcription issued
 *     (poll_handle.ts), bound to the submitting user and the media record, and
 *     it answers the job's STATUS, never its transcript.
 *
 * VTT builder:
 *   build_subtitles_file: build a WEBVTT file from the transcription text and
 *     write it under the AV subtitles folder (dir must already exist — PHP).
 *
 * PERMISSION (closure Step 3, TOOLS-3; WC-2026-09-30-transcription-record-tipo):
 * the target of every record action is a NESTED ddo (`media_ddo`,
 * `transcription_ddo`) or a top-level (section, component, record) triple, so
 * apiActions uses `permission: null` and each handler runs `gateRecord` — the
 * WRITE DOOR (`security/write_door.authorizeRecordAccess`) on the LIFTED ddo:
 * grammar, the section floor, the (section, COMPONENT) pair, the record scope.
 * Every gate is UNCONDITIONAL and runs BEFORE validation, any config lookup,
 * any ASR call and any file; a ddo without its component_tipo is refused
 * (`request.invalid`), never read as a section-only target. Effects are built
  * from the returned GRANT. The background completion poll re-runs the write
 * door immediately before it saves (a grant revoked after the enqueue writes
 * nothing).
 *
 * ONE LEVEL PER RELATION, ON EVERY PATH. The AV is only ever a SOURCE here: the
 * throwaway speech WAV (browser ASR, local engine), the `audio` quality (remote
 * ASR) and the duration a VTT is cut to are all DERIVED from it, never a change
 * to it — so every path asks READ (1) on the AV, and WRITE (2) only on what the
 * action really authors: the transcript (text_area). A transcriber who may hear
 * the recording and write its transcript gets the same answer from every engine;
 * a profile at 0 on the AV gets none of them.

 *
 * BACKGROUND: check_background_transcriber_status is in backgroundRunnable but
 * deliberately NOT in apiActions — it is unroutable from the client and only
 * enqueued by automatic_transcription itself, with principal/lang/identity
 * captured at enqueue time (ALS Rule 6: the detached poll never reads request
 * state).
 */

import { existsSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../../src/config/config.ts';
import {
	type CatalogModel,
	findCatalogModel,
	readTranscriberCatalog,
	type TranscriberCatalog,
} from '../../../src/core/ai/model_catalog.ts';
import {
	COMMON_FILES,
	DIARIZATION_COMMON_FILES,
	type DownloadReport,
	downloadModel,
	OPTIONAL_FILES,
	resolveStoreTarget,
} from '../../../src/core/ai/model_fetch.ts';
import { quarantineFile, verifiedDigest } from '../../../src/core/ai/model_integrity.ts';
import { forgetFile, recordFileComplete } from '../../../src/core/ai/model_manifest.ts';
import { pinFor, pinnedRevision } from '../../../src/core/ai/model_pins.ts';
import {
	AI_MODEL_URL_PREFIX,
	fileEvidence,
	type ModelFileEvidence,
	type ModelKind,
	type ModelState,
	type ModelStateReport,
	modelHubAllowed,
	modelState,
	modelStoreAvailable,
	modelStoreRoot,
} from '../../../src/core/ai/model_store.ts';
import type { MediaTypeSpec } from '../../../src/core/concepts/media.ts';
import { readMatrixRecord } from '../../../src/core/db/matrix.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { probeFormat } from '../../../src/core/media/engine/ffmpeg.ts';
import { mediaJobs } from '../../../src/core/media/jobs.ts';
import {
	absoluteFromRelative,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	subtitlesPath,
	subtitlesUrl,
} from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import { buildSubtitlesText } from '../../../src/core/media/tools/subtitles.ts';
import {
	deleteTranscribableAudio,
	ensureAudioQuality,
	ensureTranscribableAudio,
} from '../../../src/core/media/tools/transcription.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	relatedTipoByModel,
} from '../../../src/core/ontology/resolver.ts';
import { filterItemsByLang, readComponentItems } from '../../../src/core/resolve/component_data.ts';
import { getAlpha2FromCode } from '../../../src/core/resolve/lang_names.ts';
import { resolveLivePrincipal } from '../../../src/core/security/live_principal.ts';
import { authorizeRecordAccess, type RecordGrant } from '../../../src/core/security/write_door.ts';
import { scheduleBackground } from '../../../src/core/tools/background.ts';
import { getToolConfig } from '../../../src/core/tools/config.ts';
import { getLoadedTool } from '../../../src/core/tools/loader.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	LOCAL_ASR_ENGINE,
	mapTranscriberEngine,
	pollTranscriptionCompletion,
	resolveTranscriberConfig,
	resolveTranscriberProvider,
	resolveTranscriberStatusProvider,
	saveTranscriptionResult,
	statusPollNeedsExternalAudioUrl,
	type TranscriberProvider,
	type TranscriberStatusProvider,
} from '../../../src/core/tools/transcription_asr.ts';
import { bindingMatches, issuePollHandle, readPollHandle } from './poll_handle.ts';

export interface MediaDdo {
	component_tipo?: unknown;
	section_id?: unknown;
	section_tipo?: unknown;
}

/** The background poll action name (PHP babel_transcriber BACKGROUND_RUNNABLE). */
const BACKGROUND_POLL_ACTION = 'check_background_transcriber_status';

/** PHP empty() for required-parameter checks. */
function phpEmpty(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === '' ||
		value === 0 ||
		value === '0' ||
		value === false
	);
}

/** Read the nested media_ddo locator and normalize it to the media-tool option shape. */
function readMediaDdo(options: Record<string, unknown>): MediaDdo {
	const raw = (options.media_ddo ?? {}) as MediaDdo;
	return {
		component_tipo: raw.component_tipo,
		section_id: raw.section_id,
		section_tipo: raw.section_tipo,
	};
}

/** Read the nested transcription_ddo locator (the WRITE target of automatic_transcription). */
function readTranscriptionDdo(options: Record<string, unknown>): MediaDdo {
	const raw = (options.transcription_ddo ?? {}) as MediaDdo;
	return {
		component_tipo: raw.component_tipo,
		section_id: raw.section_id,
		section_tipo: raw.section_tipo,
	};
}

/**
 * THE RECORD GATE of every record action — the write door on the LIFTED ddo
 * (closure Step 3, TOOLS-3). `mode` is the ACTION's relation to that record:
 * 'write' (level 2) for what it authors (the transcript), 'read' (level 1)
 * for a source it only reads or derives throwaway files from (the AV). The section floor is 1; the (section, COMPONENT)
 * pair is asked — the component_tipo is REQUIRED (an absent one would collapse
 * the pair to the section, which is the hole this gate closes); the record
 * scope is asked with the non-positive-id refusal ahead of the admin bypass.
 * THROWS the write door's code; returns the grant the effect is built from.
 */
async function gateRecord(
	ddo: MediaDdo,
	ctx: ToolActionContext,
	mode: 'read' | 'write',
	door: string,
	/** The section half's floor: 1, except the shared WAV's create / delete (2 — see their handlers). */
	sectionFloor: 1 | 2 = 1,
): Promise<RecordGrant> {
	if (
		ddo.component_tipo === undefined ||
		ddo.component_tipo === null ||
		ddo.component_tipo === ''
	) {
		throw new DedaloError('request.invalid', {
			message: `${door}: the ddo names no component_tipo`,
			coordinates: { door, key: 'component_tipo' },
		});
	}
	return authorizeRecordAccess(
		ctx.principal,
		{
			section_tipo: ddo.section_tipo,
			component_tipo: ddo.component_tipo,
			section_id: ddo.section_id,
		},
		{ mode, level: mode === 'write' ? 2 : 1, sectionFloor, door },
	);
}

/** The media-tool option shape of a grant (the effect addresses what was authorized). */
function grantTarget(grant: RecordGrant): {
	component_tipo: string;
	section_tipo: string;
	section_id: number;
} {
	return {
		component_tipo: grant.componentTipo,
		section_tipo: grant.sectionTipo,
		section_id: grant.sectionId,
	};
}

/**
 * The URL the BROWSER fetches this media path at (client audience): the
 * configured web base, which already carries `/dedalo/<mediaDir>` and defaults
 * to the same-origin relative form.
 */
function clientMediaUrl(relativePath: string): string {
	return `${config.media.webBase}${relativePath}`;
}

/**
 * The URL an EXTERNAL transcriber fetches this media path at. The provider is a
 * different host: a relative URL is meaningless to it, so this REQUIRES
 * DEDALO_MEDIA_EXPORT_BASE and throws when it is unset instead of handing the
 * service an address it cannot resolve (the same unset-means-unresolved law the
 * export cells follow).
 *
 * These two audiences used to share one helper built on the old
 * DEDALO_MEDIA_BASE_URL, which it appended `/dedalo/<mediaDir>` to — so the one
 * value that worked here (a bare origin) was the one that broke the export
 * cells, which append the same relative path to the base UNCHANGED. Splitting
 * the helper is what makes both correct with a single configured value.
 */
function externalMediaUrl(relativePath: string): string {
	const base = config.media.exportBase;
	if (base === undefined || base === '') {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { tool: 'tool_transcription' },
			message:
				'DEDALO_MEDIA_EXPORT_BASE is not set: an external transcriber cannot fetch a relative media URL. Set it to the public media base (e.g. https://host/dedalo/media) in ../private/.env.',
		});
	}
	return `${base}${relativePath}`;
}

/**
 * The `av_url` a status poll must send for this engine — the CLIENT poll's half
 * of the rule `statusPollNeedsExternalAudioUrl` states (audit 2026-08 §5.6/3).
 *
 * `null` is the caller SAYING there is no published URL, which is the only
 * correct answer for the on-premise sidecar: it was POSTed the audio BYTES and
 * keys its job by its own id, and `engineering/TRANSCRIPTION.md` forbids making
 * on-premise inference depend on publishing the recording. Asking for one there
 * is not merely useless — on an install that publishes nothing (the normal
 * on-premise state) `externalMediaUrl` throws, which is exactly how the client
 * poll died with a live pid and a permanently disabled transcribe button.
 *
 * Exported so the seam itself is gated
 * (test/unit/transcription_client_poll_av_url_native.test.ts). That is only HALF
 * a gate, though, and the weaker half: pinning a helper proves the helper is
 * right, never that the handler still calls it — which is exactly how the
 * unconditional call site survived the first fix. `StatusPollSeams` exists so
 * the other half (the HANDLER's observed av_url) is gated too.
 */
export function statusPollAvUrl(engine: string, audioRelativePath: string): string | null {
	return statusPollNeedsExternalAudioUrl(engine) ? externalMediaUrl(audioRelativePath) : null;
}

/**
 * The WORLD-TOUCHING collaborators of `check_server_transcriber_status`, each
 * defaulting to the production one — the same dependency seam
 * `pollTranscriptionCompletion` already uses for its provider/save pair.
 *
 * It exists for ONE reason, and the reason is an invariant rather than a
 * convenience: `engineering/TRANSCRIPTION.md` forbids on-premise inference from
 * depending on publishing the recording, so the poll this handler performs must
 * never ask the media publication layer for a URL when the engine is the local
 * sidecar. That is a property OF THE HANDLER — of the argument it actually
 * passes — and the only honest way to assert it is to run the handler and read
 * the request the provider received. The tool config row and the media context
 * are database reads; injecting exactly those two (plus the status provider
 * that records the request), and nothing else, keeps the av_url decision and
 * the path build on the REAL code path.
 *
 * THE PERMISSION GATE IS NOT A SEAM: gateRecord always runs, before any seam is
 * consulted — a seam that could replace it would make the check optional by
 * construction. A gate driving this handler uses a principal the write door
 * really grants.
 *
 * Gate: test/unit/transcription_client_poll_av_url_native.test.ts (it also pins
 * that `tool.apiActions.check_server_transcriber_status.handler` IS this
 * function, so the gate cannot drift onto a copy the wire never reaches).
 */
export interface StatusPollSeams {
	/** The transcriber's uri/key entry for this engine, or null when unconfigured. */
	readonly transcriberConfig?: (engine: string) => Promise<{ uri: string; key: string } | null>;
	/** Media spec/identity/path options for the polled component_av record. */
	readonly mediaContext?: typeof resolveMediaToolContext;
	/** Engine → status provider routing. */
	readonly statusProvider?: typeof resolveTranscriberStatusProvider;
}

/** The part of a RecordGrant the status poll binds and builds from. */
export type PollGrant = Pick<RecordGrant, 'sectionTipo' | 'componentTipo' | 'sectionId'>;

/** Config entry by the ORIGINAL engine name (PHP $transcriber_name). */
async function defaultTranscriberConfig(
	engine: string,
): Promise<{ uri: string; key: string } | null> {
	return resolveTranscriberConfig(await getToolConfig('tool_transcription'), engine);
}

async function createTranscribableAudioFile(ctx: ToolActionContext): Promise<ToolResponse> {
	// READ on the AV: the WAV is a derivative of the recording (the same WAV the
	// local engine of automatic_transcription builds behind the same read gate).
	// The SECTION at WRITE (2), HEAD's level — the same as its delete (see there):
	// whoever may build the shared WAV may remove it, so a build never leaves a
	// copy of the interview its builder cannot delete.
	const grant = await gateRecord(
		readMediaDdo(ctx.options),
		ctx,
		'read',
		'tool_transcription.create_transcribable_audio_file',
		2,
	);

	const { spec, identity, pathOpts } = await resolveMediaToolContext(grantTarget(grant));
	const relativePath = await ensureTranscribableAudio(spec, identity, pathOpts);
	return ok(clientMediaUrl(relativePath), { requestId: toolRequestId(ctx) });
}

async function deleteTranscribableAudioFile(ctx: ToolActionContext): Promise<ToolResponse> {
	// READ on the AV (the WAV is a derivative, never the AV) — but the SECTION at
	// WRITE (2), the level HEAD asked (TOOLS-3 review r8), like its creation.
	// Deleting it is an effect on OTHER users: it is ONE file per record
	// (transcribableAudioLocation), so an unlink breaks a concurrent user's
	// browser-ASR fetch of it, or a local-engine submit that has built it but not
	// yet read its bytes — a read-only viewer of the recording may not do that.
	// Create and delete share the level, so no builder is left unable to remove
	// the copy. (The race between two users who BOTH may delete is
	// level-independent — WC-2026-09-30-transcription-record-tipo, owner review.)
	const grant = await gateRecord(
		readMediaDdo(ctx.options),
		ctx,
		'read',
		'tool_transcription.delete_transcribable_audio_file',
		2,
	);

	const { spec, identity, pathOpts } = await resolveMediaToolContext(grantTarget(grant));
	// `deleted` says whether a file was actually there — a FACT of the payload
	// (the legacy body carried it only inside its `msg` prose).
	const deleted = deleteTranscribableAudio(spec, identity, pathOpts);
	return ok({ deleted }, { requestId: toolRequestId(ctx) });
}

/**
 * The seams of automatic_transcription — each defaulting to production. A gate
 * drives the SUBMIT through them (an ASR sidecar is not served in a test, and
 * the detached poll must not really be enqueued), keeping the media context,
 * the WAV location and the cleanup on the REAL code path.
 *
 * THE RECORD GATE IS NOT A SEAM. gateRecord always runs, on both ddos, before
 * any seam is consulted: a seam that could replace the permission check would
 * make the check optional by construction (and hide it from the permission
 * census, which must see the gate called on the handler's entry path). A gate
 * that drives this handler builds a principal the write door really grants.
 */
export interface AutomaticSubmitSeams {
	/** The transcriber's uri/key entry for this engine, or null when unconfigured. */
	readonly transcriberConfig?: (engine: string) => Promise<{ uri: string; key: string } | null>;
	/** The submit itself (production: routed from the engine). */
	readonly provider?: TranscriberProvider;
	/** Enqueue the completion poll (production: scheduleCompletionPoll). */
	readonly schedule?: (
		pollOptions: Record<string, unknown>,
		ctx: ToolActionContext,
	) => Promise<void>;
}

/**
 * Detach the completion poll (PHP exec_background_check_transcription).
 * EVERYTHING the poll needs — principal, user, lang, target ddo, the exact
 * submitted av_url — is in `pollOptions`, captured at enqueue time; the
 * detached handler never reads ALS (isolation Rule 6).
 */
async function scheduleCompletionPoll(
	pollOptions: Record<string, unknown>,
	ctx: ToolActionContext,
): Promise<void> {
	const loaded = await getLoadedTool('tool_transcription');
	if (loaded === undefined) {
		console.error(
			'[tool_transcription] could not schedule the background completion poll (module not loaded); the client can still poll check_server_transcriber_status',
		);
		return;
	}
	scheduleBackground(
		loaded,
		BACKGROUND_POLL_ACTION,
		{
			permission: null,
			gatedInHandler:
				'A BACKGROUND-ONLY spec: BACKGROUND_POLL_ACTION is absent from apiActions, so it is unroutable from the wire and can only be enqueued from here, after automaticTranscription has run its gateRecord pair. User and target ddo are captured at enqueue time (isolation Rule 6); the SAVE re-runs the write door (authorizeRecordAccess on a freshly resolved principal) immediately before the transcript is written, so a grant revoked after the enqueue writes nothing.',
			handler: backgroundTranscriberPoll,
		},
		pollOptions,
		ctx.principal,
		ctx.userId,
	);
}

/**
 * automatic_transcription — the REMOTE ASR submit (external seam). Ensure the
 * audio quality, submit its URL to the configured transcriber server (which
 * returns a job PID), then detach the bounded background completion poll that
 * writes the transcript back (PHP exec_background_check_transcription →
 * check_background_transcriber_status → process_file).
 *
 * THE ON-PREMISE WAV IS THE SUBMIT'S, NEVER THE POLL'S. The local engine is
 * POSTed the WAV's BYTES in the submit itself (transcription_local_asr.ts
 * submitForm), so once the submit has SETTLED — accepted, refused or thrown — no
 * later step reads the file, and it is dropped right there. It used to ride the
 * enqueued poll (`cleanup_path`), which left a copy of the interview on disk
 * whenever the poll never ran its handler: a refused or failed submit (nothing
 * enqueued), an unloaded tool, a job stopped while queued, a restart.
 * (Gate: transcription_submit_drops_audio_native, through the seams below.)
 */
export async function automaticTranscription(
	ctx: ToolActionContext,
	seams: AutomaticSubmitSeams = {},
): Promise<ToolResponse> {
	const o = ctx.options;
	// THE GATES FIRST (closure Step 3, TOOLS-3): unconditional, before any
	// validation, config lookup or provider call. WRITE on the transcription
	// target — its component_tipo REQUIRED (the write gate used to be section-only
	// by construction) — then READ on the media SOURCE (TOOLS-06: without it a
	// caller who can write their OWN transcription target could transcribe the
	// restricted audio of ANY AV record into a record they control).
	const transcriptionGrant = await gateRecord(
		readTranscriptionDdo(o),
		ctx,
		'write',
		'tool_transcription.automatic_transcription.transcription_ddo',
	);
	const mediaGrant = await gateRecord(
		readMediaDdo(o),
		ctx,
		'read',
		'tool_transcription.automatic_transcription.media_ddo',
	);

	const sourceLang = String(o.source_lang ?? '');
	const engine = String(o.transcriber_engine ?? 'babel_transcriber');
	const quality = String(o.transcriber_quality ?? '');
	if (sourceLang === '' || quality === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage:
				'Missing required parameters: source_lang, transcriber_quality, media_ddo, transcription_ddo',
		});
	}

	const { provider: routed, error: providerError } = resolveTranscriberProvider(engine);
	const provider = routed === null ? null : (seams.provider ?? routed);
	if (provider === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: providerError ?? 'unknown transcriber engine',
			coordinates: { engine },
		});
	}
	// Config entry is looked up by the ORIGINAL engine name; the POSTed
	// engine field uses the mapped one ('local' → babel) — PHP does both.
	const cfg = await (seams.transcriberConfig ?? defaultTranscriberConfig)(engine);
	if (cfg === null) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { engine },
			message: `Transcriber config (uri/key) is not defined for '${engine}'`,
		});
	}
	const mappedEngine = mapTranscriberEngine(engine);

	const { spec, identity, pathOpts } = await resolveMediaToolContext(grantTarget(mediaGrant));

	// Two ways to hand a recogniser the audio, and the choice is not cosmetic:
	//  - an EXTERNAL service fetches a public URL (and so needs one to exist);
	//  - the institution's OWN box is POSTed the bytes of the speech-optimised
	//    WAV, so the recording is never published anywhere. That WAV is a
	//    throwaway derivative, deleted as soon as the submit settles (below).
	const isLocalEngine = engine === LOCAL_ASR_ENGINE;
	const audioRel = isLocalEngine
		? await ensureTranscribableAudio(spec, identity, pathOpts)
		: await ensureAudioQuality(spec, identity, pathOpts);
	const audioPath = isLocalEngine ? absoluteFromRelative(audioRel, pathOpts.mediaRoot) : undefined;
	// An on-premise engine never receives a URL; asking for one would throw
	// when DEDALO_MEDIA_EXPORT_BASE is unset, which is the normal state of an
	// install that publishes nothing.
	const audioUrl = isLocalEngine ? '' : externalMediaUrl(audioRel);

	let result: Awaited<ReturnType<TranscriberProvider>>;
	try {
		result = await provider({
			uri: cfg.uri,
			key: cfg.key,
			engine: mappedEngine,
			quality,
			audioUrl,
			audioPath,
			langTld2: getAlpha2FromCode(sourceLang) ?? '',
			userId: ctx.userId,
			entityName: config.entity,
		});
	} finally {
		// The bytes have left in the POST (or never will): see the header.
		if (audioPath !== undefined) dropTemporaryAudio(audioPath);
	}
	// The submit seam answers its own internal `{ok, pid|msg}` outcome
	// (src/core/tools/transcription_asr.ts TranscribeResult): an
	// unreachable/blocked ASR server is a dependency failure, not a caller fault.
	if (!result.ok) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { engine: mappedEngine },
			message: result.msg,
		});
	}

	// Detach the completion poll (PHP exec_background_check_transcription).
	// EVERYTHING the poll needs — principal, user, lang, target ddo, the
	// exact submitted av_url — is captured HERE at enqueue time; the
	// detached handler never reads ALS (isolation Rule 6).
	await (seams.schedule ?? scheduleCompletionPoll)(
		{
			key: cfg.key,
			url: cfg.uri,
			lang: sourceLang,
			av_url: audioUrl,
			// NO cleanup_path: the on-premise WAV was dropped when the submit
			// settled (see the header) — the poll never owns a file.
			engine: mappedEngine,
			user_id: ctx.userId,
			entity_name: config.entity,
			transcription_ddo: grantTarget(transcriptionGrant),
			pid: result.pid,
		},
		ctx,
	);

	// THE CLIENT GETS A HANDLE, NOT THE JOB ID (TOOLS-3 review r7): the raw id
	// stays server-side (the background poll above holds it); the sealed handle
	// binds it to this user, this engine and the media GRANT, and is the only
	// `pid` check_server_transcriber_status accepts. The client stores and echoes
	// it unchanged. WC-007: the legacy body's success msg is dropped.
	const pollHandle = issuePollHandle({
		pid: result.pid,
		engine,
		userId: ctx.userId,
		sectionTipo: mediaGrant.sectionTipo,
		componentTipo: mediaGrant.componentTipo,
		sectionId: mediaGrant.sectionId,
	});
	return ok({ pid: pollHandle }, { requestId: toolRequestId(ctx) });
}

/**
 * The seams of the detached completion poll — each defaulting to production.
 * A gate drives the REVOCATION leg through them (loopback ASR is SSRF-refused
 * by design, so the status provider is injected, not served).
 */
export interface BackgroundPollSeams {
	/** The status provider itself (production: routed from the job's engine). */
	readonly statusProvider?: TranscriberStatusProvider;
	/** Observes a transcript that WAS written (gates count it). */
	readonly onSaved?: () => void;
	readonly maxAttempts?: number;
	readonly intervalMs?: number;
}

/**
 * The detached completion poll (PHP babel_transcriber::
 * check_background_transcriber_status). Runs under the background executor;
 * reads its whole world from the options captured at enqueue time.
 *
 * THE SAVE RE-GATES (closure Step 3, TOOLS-3). The poll runs for up to half an
 * hour after the enqueue; the grant that admitted the enqueue may be revoked in
 * between. So the save seam resolves the principal AFRESH and re-runs the write
 * door on the transcription target immediately before the write — a refusal is
 * the job's terminal state (nothing written), never a silent pass.
 */
export async function backgroundTranscriberPoll(
	ctx: ToolActionContext,
	seams: BackgroundPollSeams = {},
): Promise<ToolResponse> {
	const o = ctx.options;
	const ddo = (o.transcription_ddo ?? {}) as MediaDdo;
	const lang = String(o.lang ?? '');
	// The poll owns NO file: the on-premise WAV is dropped when the submit settles
	// (automaticTranscription). Jobs die on restart (background.ts), so no job
	// enqueued by the retired `cleanup_path` producer can reach this handler.
	const outcome = await pollTranscriptionCompletion(
		{
			status: {
				uri: String(o.url ?? ''),
				key: String(o.key ?? ''),
				avUrl: String(o.av_url ?? ''),
				engine: String(o.engine ?? ''),
				userId: Number(o.user_id ?? ctx.userId),
				entityName: String(o.entity_name ?? ''),
				pid: (o.pid ?? '') as string | number,
				lang,
			},
			lang,
			transcriptionDdo: {
				component_tipo: String(ddo.component_tipo ?? ''),
				section_tipo: String(ddo.section_tipo ?? ''),
				section_id: Number(ddo.section_id ?? 0),
			},
			userId: ctx.userId,
		},
		{
			...(seams.statusProvider === undefined ? {} : { provider: seams.statusProvider }),
			...(seams.maxAttempts === undefined ? {} : { maxAttempts: seams.maxAttempts }),
			...(seams.intervalMs === undefined ? {} : { intervalMs: seams.intervalMs }),
			save: async (input) => {
				const refusal = await authorizeBackgroundSave(ctx.userId, input.transcriptionDdo);
				if (refusal !== null) return { saved: false, msg: refusal };
				const saved = await saveTranscriptionResult(input);
				if (saved.saved) seams.onSaved?.();
				return saved;
			},
		},
	);

	// A BACKGROUND job: a refusal here is the job's terminal state (background.ts
	// records `error` on the job record), not a wire body.
	if (!outcome.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { action: BACKGROUND_POLL_ACTION },
			message: outcome.msg,
		});
	}
	return ok(true, { requestId: toolRequestId(ctx) });
}

/** Delete the job's temporary audio copy, if any (a failure is logged, never thrown). */
function dropTemporaryAudio(cleanupPath: string): void {
	if (cleanupPath === '' || !existsSync(cleanupPath)) return;
	try {
		unlinkSync(cleanupPath);
	} catch (error) {
		console.error(
			`[tool_transcription] could not delete the temporary audio ${cleanupPath}:`,
			error,
		);
	}
}

/**
 * The background save's re-gate: the write door on the transcription target,
 * for the principal resolved NOW (not the one captured at enqueue) — and only
 * for a LIVE account: a deactivated (dd131 = No) or deleted user writes nothing
 * even while their profile still grants the pair (`resolveLivePrincipal`).
 * Returns null when authorized, else the refusal sentence the job records — a
 * typed refusal is the job's terminal state, never an escape from the poll.
 */
async function authorizeBackgroundSave(
	userId: number,
	target: { component_tipo: string; section_tipo: string; section_id: number },
): Promise<string | null> {
	try {
		const principal = await resolveLivePrincipal(userId, 'tool_transcription.background_save');
		await authorizeRecordAccess(principal, target, {
			mode: 'write',
			level: 2,
			sectionFloor: 1,
			door: 'tool_transcription.background_save',
		});
		return null;
	} catch (error) {
		if (!(error instanceof DedaloError)) throw error;
		console.error(
			`[tool_transcription] the background save was refused (${error.code}): ${error.message}`,
		);
		return `the transcript was not saved: ${error.code}`;
	}
}

/**
 * check_server_transcriber_status — the CLIENT's poll of a running job (PHP
 * :669-788). READ gate (level 1) on media_ddo: polling reconstructs the audio
 * URL but writes nothing. delete_result=false — only the server-side
 * background poll may let babel clean up the finished result.
 *
 * ITS OWN JOB, AND ONLY ITS STATUS (TOOLS-3 review r7). `pid` must be the poll
 * handle automatic_transcription issued (poll_handle.ts): sealed by this
 * process, bound to THIS user and to the record of THIS poll's read grant. The
 * job id and the engine polled are the HANDLE's — never the payload's (the
 * client's `transcriber_engine` is not read). A handle that does not verify or
 * does not match — a raw or guessed job id, another user's handle (a shared
 * workstation's IndexedDB), a handle from before a restart — is answered with
 * status 1, the protocol's "no process matching this pid": truthful for this
 * caller, the same answer whether or not such a job exists (no oracle), and the
 * answer that lets the client drop the stale handle instead of erroring on every
 * reload. Nothing is looked up or polled for it. The answer carries the STATUS
 * alone: the finished transcript is written server-side by the background save,
 * and the client never needed it (it reads only `status`).
 *
 * `seams` defaults to the production collaborators; see StatusPollSeams for why
 * the gate that matters has to invoke THIS function.
 */
export async function checkServerTranscriberStatus(
	ctx: ToolActionContext,
	seams: StatusPollSeams = {},
): Promise<ToolResponse> {
	// The READ gate, UNCONDITIONAL and BEFORE validation (closure Step 3,
	// TOOLS-3): PHP gated only when media_ddo->section_tipo was present, so a
	// payload without it reached the config lookup ungated — now it is a gate
	// refusal (request.invalid), before any seam is touched.
	// The grant (level 1, the write door's read mode) is what the poll handle is
	// matched against and what the media context is built from.
	const grant: PollGrant = await gateRecord(
		readMediaDdo(ctx.options),
		ctx,
		'read',
		'tool_transcription.check_server_transcriber_status',
	);

	const rawDdo = ctx.options.media_ddo ?? null;
	const handle = ctx.options.pid;

	const missing: string[] = [];
	if (rawDdo === null) missing.push('media_ddo');
	if (phpEmpty(handle)) missing.push('pid');
	if (missing.length > 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `Missing required parameters: ${missing.join(', ')}`,
		});
	}

	// THE JOB IS THE HANDLE'S, AND THE HANDLE IS THIS CALLER'S ON THIS RECORD.
	const binding = readPollHandle(handle);
	if (binding === null || !bindingMatches(binding, ctx.userId, grant)) {
		if (binding !== null) {
			console.warn(
				`[tool_transcription] a poll handle of user ${binding.userId} on ${binding.sectionTipo}/${binding.componentTipo}/${binding.sectionId} was presented by user ${ctx.userId} on ${grant.sectionTipo}/${grant.componentTipo}/${grant.sectionId} — answered as no job`,
			);
		}
		return ok({ status: 1 }, { requestId: toolRequestId(ctx) });
	}
	const engine = binding.engine;

	const cfg = await (seams.transcriberConfig ?? defaultTranscriberConfig)(engine);
	if (cfg === null) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { engine },
			message: `Transcriber config (uri/key) is not defined for '${engine}'`,
		});
	}

	const { provider, error: providerError } = (
		seams.statusProvider ?? resolveTranscriberStatusProvider
	)(engine);
	if (provider === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: providerError ?? `Sorry. '${engine}' is not implemented yet`,
			coordinates: { engine },
		});
	}

	// Rebuild av_url EXACTLY as automatic_transcription submitted it (same
	// context resolution, same URL builder) — an EXTERNAL transcriber backend
	// identifies the job by this URL, so it must match byte-for-byte. The
	// on-premise engine was submitted no URL at all (audioUrl '') and must be
	// polled with none: see statusPollAvUrl.
	const { spec, identity, pathOpts } = await (seams.mediaContext ?? resolveMediaToolContext)({
		component_tipo: grant.componentTipo,
		section_tipo: grant.sectionTipo,
		section_id: grant.sectionId,
	});
	if (spec.model !== 'component_av') {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `'${grant.componentTipo}' is not component_av`,
			coordinates: { tipo: grant.componentTipo, model: spec.model },
		});
	}
	// PURE path build (PHP: $component->get_url('audio')) — a READ-gated poll
	// must NEVER transcode. Only automatic_transcription ENSURES the audio
	// quality, and that action is WRITE-gated.
	const audioRel = buildMediaLocation(
		spec,
		identity,
		'audio',
		spec.defaultExtension,
		pathOpts,
	).relativePath;

	const result = await provider({
		uri: cfg.uri,
		key: cfg.key,
		avUrl: statusPollAvUrl(engine, audioRel),
		engine: mapTranscriberEngine(engine),
		userId: ctx.userId,
		entityName: config.entity,
		pid: binding.pid,
		deleteResult: false,
	});

	// The transcriber is EXTERNAL: an unreachable server, an HTTP error or a
	// blocked (SSRF) URI comes back as the provider's `{ok:false, msg}`
	// outcome, NOT as a thrown error. Report it as a FAILURE — WC-007 rewrites
	// the msg on the SUCCESS branch only; a down ASR server must never read OK.
	if (result === null || result === undefined) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { engine },
			message: 'Transcriber server returned no status',
		});
	}
	if (typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { engine },
			message: String((result as { msg?: unknown }).msg ?? 'transcriber request failed'),
		});
	}
	// …AND SO DOES A POLL THAT NEVER REACHED THE BOX. The background completion
	// loop treats that as "keep waiting" on purpose — the sidecar may still be
	// working, and one 30-second stall must not abandon an hour of audio. THIS
	// poll is the opposite case: it answers a person, once. Without this branch a
	// `{status:2}` from an unplugged transcriber returned a SUCCESS envelope, and
	// the client (render_tool_transcription.js `case 2:`) re-armed a 4-second
	// timer with no ceiling and painted 'Processing' for the rest of the session,
	// while nothing anywhere said the transcriber was unreachable.
	if (typeof result === 'object' && (result as { unreachable?: unknown }).unreachable === true) {
		throw new DedaloError('tool.dependency_unavailable', {
			coordinates: { engine },
			message: String((result as { msg?: unknown }).msg ?? 'the transcriber did not answer'),
		});
	}

	// THE STATUS ONLY (see the header): a finished job's `transcription_data` —
	// the whole transcript — never rides the client poll. WC-007: the legacy
	// body's success msg is dropped — `ok` IS the success.
	const { status, msg } = result as { status?: unknown; msg?: unknown };
	return ok(
		{ status: status ?? null, ...(typeof msg === 'string' ? { msg } : {}) },
		{ requestId: toolRequestId(ctx) },
	);
}

/**
 * PHP component_av::get_duration — the AV file's duration in seconds via
 * ffprobe on the default-quality file. The stored files_info entry locates the
 * file first (DB order); the computed grammar location is the fallback. 0 when
 * no file / probe failure (PHP returns 0.0).
 */
async function resolveAvDuration(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	items: Record<string, unknown>[],
): Promise<number> {
	let absolute: string | null = null;

	// 1) stored files_info entry for the default quality
	const filesInfo = (items[0]?.files_info ?? null) as
		| { quality?: unknown; file_exist?: unknown; file_path?: unknown; external?: unknown }[]
		| null;
	if (Array.isArray(filesInfo)) {
		const stored = filesInfo.find(
			(entry) =>
				entry !== null &&
				typeof entry === 'object' &&
				entry.quality === spec.defaultQuality &&
				entry.file_exist === true &&
				entry.external !== true &&
				typeof entry.file_path === 'string',
		);
		if (stored !== undefined) {
			try {
				const candidate = absoluteFromRelative(stored.file_path as string, pathOpts.mediaRoot);
				if (existsSync(candidate)) absolute = candidate;
			} catch {
				absolute = null;
			}
		}
	}

	// 2) fallback: the deterministic grammar location
	if (absolute === null) {
		const location = buildMediaLocation(
			spec,
			identity,
			spec.defaultQuality,
			spec.defaultExtension,
			pathOpts,
		);
		if (existsSync(location.absolutePath)) absolute = location.absolutePath;
	}

	if (absolute === null) return 0;
	const format = (await probeFormat(absolute)) as { format?: { duration?: unknown } } | null;
	const duration = Number(format?.format?.duration ?? 0);
	return Number.isFinite(duration) ? duration : 0;
}

/**
 * build_subtitles_file — generate the WEBVTT file from the transcription text
 * (PHP :827-990). WRITE gate (level 2) on (section_tipo, component_tipo) plus
 * record-in-scope. The target subtitles dir must ALREADY exist (PHP does not
 * create it); on success the VTT is written and its public URL returned.
 */
async function buildSubtitlesFile(ctx: ToolActionContext): Promise<ToolResponse> {
	const o = ctx.options;

	// THE GATES FIRST, UNCONDITIONAL (closure Step 3, TOOLS-3): WRITE on the
	// transcript's (section, text_area, record) — a missing tipo or id is a gate
	// refusal, not a validation list; the VTT is the transcript's own derivative —
	// then READ on the RELATED AV, whose duration this reads and beside which the
	// VTT is stored: a transcript-writer holding 0 on the AV gets nothing, one who
	// may hear the recording gets what every other transcription path gives them.
	const textGrant = await gateRecord(
		{ section_tipo: o.section_tipo, component_tipo: o.component_tipo, section_id: o.section_id },
		ctx,
		'write',
		'tool_transcription.build_subtitles_file',
	);
	const sectionTipo = textGrant.sectionTipo;
	const componentTipo = textGrant.componentTipo;
	const sectionId = textGrant.sectionId;

	// Resolve the related AV component (the ontology 'related' pairing —
	// PHP get_related_component_av_tipo).
	const avTipo = await relatedTipoByModel(componentTipo, 'component_av');
	if (avTipo === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `No component_av is related to '${componentTipo}'`,
			coordinates: { tipo: componentTipo },
		});
	}
	const avGrant = await gateRecord(
		{ section_tipo: sectionTipo, component_tipo: avTipo, section_id: sectionId },
		ctx,
		'read',
		'tool_transcription.build_subtitles_file.av',
	);

	const lang = String(o.lang ?? '');
	const key = Number(o.key ?? 0); // fixed component dato key, default 0
	const maxCharline = Number(o.max_charline ?? 0);

	const missing: string[] = [];
	if (phpEmpty(o.lang)) missing.push('lang');
	if (phpEmpty(o.max_charline)) missing.push('max_charline');
	if (missing.length > 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `Missing required parameters: ${missing.join(', ')}`,
		});
	}

	// Read the transcription text (PHP get_data_lang(lang)[key]->value).
	const model = await getModelByTipo(componentTipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', { coordinates: { tipo: componentTipo } });
	}
	const table = await getMatrixTableFromTipo(sectionTipo);
	const record = table !== null ? await readMatrixRecord(table, sectionTipo, sectionId) : null;
	const items = record !== null ? (readComponentItems(record, componentTipo, model) ?? []) : [];
	const langItems = filterItemsByLang(items, lang);
	const rawValue = (langItems[key] as { value?: unknown } | undefined)?.value;
	const sourceText = String(rawValue ?? '').trim();
	if (sourceText === '') {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: 'The transcription component is empty; there is nothing to subtitle',
			coordinates: { tipo: componentTipo, section_tipo: sectionTipo, section_id: sectionId },
		});
	}

	// AV duration → total_ms (PHP get_duration * 1000, rounded).
	const {
		spec: avSpec,
		identity: avIdentity,
		pathOpts: avPathOpts,
		items: avItems,
	} = await resolveMediaToolContext(grantTarget(avGrant));
	const duration = await resolveAvDuration(avSpec, avIdentity, avPathOpts, avItems);
	const totalMs = Math.round(duration * 1000);

	const subtitles = buildSubtitlesText({
		sourceText,
		maxCharLine: maxCharline,
		total_ms: totalMs,
	});
	if (subtitles.data === false) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tipo: componentTipo, section_id: sectionId },
			message: `Unable to build subtitles: ${subtitles.msg}`,
		});
	}

	// Target path/url — the ONE shared subtitles grammar (media/path.ts).
	const vttPath = subtitlesPath(avIdentity, lang, avPathOpts.mediaRoot);
	const targetFolder = dirname(vttPath);
	if (!existsSync(targetFolder)) {
		// PHP semantics: the dir must already exist — do NOT create it. The path
		// is a server-side location: LOG-only (coordinates), never on the wire.
		throw new DedaloError('tool.action_failed', {
			coordinates: { subtitles_dir: targetFolder },
			message: `The subtitles dir does not exist: ${targetFolder}`,
		});
	}
	writeFileSync(vttPath, subtitles.data);

	// `url` stays a TOP-LEVEL extension key: the client reads response.url.
	return ok(true, {
		requestId: toolRequestId(ctx),
		extend: { url: subtitlesUrl(avIdentity, lang) },
	});
}

/**
 * get_model_sources — where the BROWSER engine may load its model from.
 *
 * The browser cannot read the install's configuration, so without this the
 * operator switches (`DEDALO_AI_MODEL_STORE`, `DEDALO_AI_MODEL_ALLOW_HUB`) would
 * be inert and the worker would be guessing. It answers three facts:
 *   model_host  — the store URL to load weights from (this install's own);
 *   allow_hub   — whether falling back to a public model hub is permitted
 *                 (default NO: the recordings are personal data, and an
 *                 air-gapped archive must work);
 *   store_ready — whether the store actually has anything in it, so the tool can
 *                 say "ask your administrator to seed the model store" instead of
 *                 failing with a 404 from inside the ONNX runtime.
 *
 * No record is addressed and nothing is written; the answer is install
 * configuration the logged-in user's own browser is about to act on.
 */
async function getModelSources(ctx: ToolActionContext): Promise<ToolResponse> {
	// The facts that hold whatever the catalog does: they come from config and the
	// filesystem, never from the database.
	const base = {
		model_host: AI_MODEL_URL_PREFIX,
		allow_hub: modelHubAllowed(),
		store_ready: modelStoreAvailable(),
	};

	return ok(buildModelSourcesPayload(await readTranscriberCatalog(), base), {
		requestId: toolRequestId(ctx),
	});
}

/**
 * THE DEGRADED-ANSWER CONTRACT, as a pure function of what the catalog read
 * produced — so it can be gated without a database, and so the one decision it
 * encodes (absent ≠ empty) has a name.
 *
 * Gate: test/unit/tool_transcription.test.ts, "the degraded answer".
 */
export function buildModelSourcesPayload(
	catalog: TranscriberCatalog,
	base: { model_host: string; allow_hub: boolean; store_ready: boolean },
): Record<string, unknown> {
	if (!catalog.readable) {
		// THE DEGRADED ANSWER. `installed` and `models` are OMITTED — not empty.
		//
		// An empty array is a real answer ("nothing is installed") that the client
		// acts on: it greys the model out, refuses the run, and offers a Download
		// the server then contradicts. A momentary database hiccup would therefore
		// tell every archivist their model was never installed. An ABSENT field is
		// the wire's way of saying "this server cannot tell", and every consumer
		// keeps its previous permissive behaviour when it sees one. Same rule for
		// `diarization`: absent = cannot tell, null = this install declares no
		// speaker detection.
		console.error(
			'[tool_transcription] get_model_sources: the model catalog could not be read — reporting the model fields as UNKNOWN (absent), never as empty',
		);
		return { ...base };
	}

	// Which catalog models are USABLE right now, and in what way. A boolean
	// "installed" could not distinguish a model nobody downloaded from one whose
	// download was killed mid-file — and it was the second that reached the
	// browser as "ERROR_CODE: 7 … protobuf parsing failed" with nothing in the UI.
	const installed: string[] = [];
	const models: { name: string; state: string; files: unknown[] }[] = [];
	for (const entry of catalog.asr) {
		const report = modelState(entry.name, entry.dtype, entry.kind);
		models.push({ name: entry.name, state: report.state, files: report.files });
		// `installed` KEEPS its old meaning — "the browser may try this" — so an
		// older client is never made worse by this change. An unverified model is
		// the normal state of every store seeded before the manifest existed: it
		// runs, with a warning.
		if (isRunnableState(report.state)) installed.push(entry.name);
	}

	// The speaker-detection models (separate catalog slots — never in the ASR
	// quality picker): segmentation (WHO speaks WHEN) + the voice-fingerprint
	// embedding model (the SAME voice keeps the SAME id across the whole
	// recording — without it, long recordings fragment one voice into several
	// detected speakers).
	//
	// BOTH HALVES REPORT THEIR OWN STATE. `installed` here used to be
	// `modelInstalled()` — the old `size > 0` test this whole change exists to
	// retire — so a truncated pyannote file enabled the checkbox and the worker
	// died with exactly the "ERROR_CODE: 7 … protobuf parsing failed" the ASR path
	// no longer produces. And a single boolean could not say WHICH half was
	// broken, so the remedy could not be aimed: the panel's Repair went to the
	// selected ASR model, repaired something that was never broken, and reported
	// success. `models` carries one entry per half, each with its own state and
	// its own name to aim a remedy at.
	return {
		...base,
		installed,
		models,
		diarization: buildDiarizationPanel(catalog.diarization),
	};
}

/**
 * A model state the browser may attempt. THE one rule, shared by the ASR
 * `installed` list, the diarization panel and the widget's usable count — the
 * five states must mean one thing everywhere or the picker and the refusal
 * disagree again.
 */
function isRunnableState(state: ModelState): boolean {
	return state === 'ready' || state === 'unverified';
}

/** One half of speaker detection, as the client reads it. */
export interface DiarizationPart {
	/** 'segmentation' (who speaks when) | 'embedding' (the voice fingerprint). */
	role: string;
	name: string;
	label?: string;
	state: ModelState;
}

export interface DiarizationPanel {
	name: string;
	label?: string;
	size_mb?: number;
	/** Every half runnable. Kept for older clients; `models` is the real answer. */
	installed: boolean;
	/** The WORST half's state — what the pair as a whole is in. */
	state: ModelState;
	models: DiarizationPart[];
	embedding_name?: string;
}

/** Worst first: what the pair is in is what its unhealthiest half is in. */
const STATE_SEVERITY: readonly ModelState[] = [
	'missing',
	'damaged',
	'incomplete',
	'unverified',
	'ready',
];

function worstState(states: readonly ModelState[]): ModelState {
	for (const candidate of STATE_SEVERITY) {
		if (states.includes(candidate)) return candidate;
	}
	return 'missing';
}

/**
 * The speaker-detection pair, each half answering for itself. Null when the
 * install declares no segmentation model (speaker detection is simply absent) —
 * which is a REAL answer, unlike the absent field a degraded read produces.
 *
 * Pure: the catalog was already read (once) by the caller, so the same slots
 * cannot be read twice and disagree.
 */
function buildDiarizationPanel(entries: readonly CatalogModel[]): DiarizationPanel | null {
	const segmentation = entries.find((entry) => entry.role === 'segmentation');
	if (segmentation === undefined) return null;
	const embedding = entries.find((entry) => entry.role === 'embedding');

	const models: DiarizationPart[] = entries.map((entry) => ({
		role: entry.role ?? 'segmentation',
		name: entry.name,
		label: entry.label,
		state: modelState(entry.name, entry.dtype, entry.kind).state,
	}));

	return {
		name: segmentation.name,
		label: segmentation.label,
		size_mb: (segmentation.size_mb ?? 0) + (embedding?.size_mb ?? 0),
		installed: models.every((part) => isRunnableState(part.state)),
		state: worstState(models.map((part) => part.state)),
		models,
		embedding_name: embedding?.name,
	};
}

/** The background download action name (allowlisted, never client-routable). */
const BACKGROUND_DOWNLOAD_ACTION = 'background_download_model';

/**
 * download_model — seed one catalog model into the local store, from the UI.
 *
 * Before this, seeding required shell access (`scripts/fetch_ai_models.ts`) —
 * out of reach for the administrator of a hosted install, whose users saw every
 * uninstalled model greyed out with "ask your administrator" and no way for that
 * administrator to act.
 *
 * GATES, in order:
 *  - GLOBAL ADMIN only. This makes the server fetch ~1 GB from the public hub
 *    and write it to disk — an operator act, not a cataloguer's.
 *  - The model must be IN THE CATALOG. The id becomes a URL path on the hub and
 *    a directory under the store; free-form input would let a request download
 *    arbitrary repos or write outside the intended folder. Catalog names only.
 *
 * The download runs as a DETACHED background job (it can take many minutes;
 * identity captured at enqueue time), and the client polls `get_model_sources`
 * until the model turns up in `installed`. Note the deliberate asymmetry with
 * DEDALO_AI_MODEL_ALLOW_HUB: that flag governs the BROWSER streaming weights at
 * inference time (a per-recording privacy leak); this is the server seeding its
 * own store once, on an explicit admin request.
 */
async function downloadModelAction(ctx: ToolActionContext): Promise<ToolResponse> {
	if (ctx.principal?.isGlobalAdmin !== true) {
		throw new DedaloError('perm.denied', {
			coordinates: { tool: 'tool_transcription', action: 'download_model' },
		});
	}

	const model = String(ctx.options.model ?? '');
	// Catalog names only (see the gate list above). Two slots qualify: the ASR
	// quality catalog, and the diarization models — which download a different
	// file set (no tokenizer; the preprocessor config is mandatory).
	const entry = await findCatalogModel(model);
	if (entry === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `Unknown model: '${model}' is not in the transcriber catalog`,
			coordinates: { model },
		});
	}
	// SAME guard as repair, and the same reason: two `curl -C -` runs over one
	// target interleave their resumes. One button, one poll that says nothing for
	// minutes — a second click is what an impatient administrator does. Checked
	// BEFORE the state is read, because a model another job is actively writing
	// has no settled state to short-circuit on.
	const busy = modelJobInFlight(entry.name);
	if (busy !== null) refuseBusyModel(entry.name, busy);

	// STATE-AWARE short-circuit. `modelInstalled` (the old size > 0 test) called a
	// truncated or corrupted install "already installed", so the client — which
	// offers Download for anything absent from `installed`, and that includes
	// `incomplete` and `damaged` — read a success it then polled for thirty
	// minutes against a model that was never going to appear. Only a RUNNABLE
	// model is already installed; a broken one is told what actually fixes it.
	const state = modelState(entry.name, entry.dtype, entry.kind).state;
	if (isRunnableState(state)) {
		return ok({ already_installed: true, state }, { requestId: toolRequestId(ctx) });
	}
	if (state !== 'missing') {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `Model '${model}' is on disk but ${state}: downloading it again cannot fix that — repair it instead`,
			coordinates: { model, state },
		});
	}

	const loaded = await getLoadedTool('tool_transcription');
	if (loaded === undefined) {
		throw new DedaloError('tool.no_server_module', {
			coordinates: { tool: 'tool_transcription', action: 'download_model' },
		});
	}
	return scheduleModelJob({
		action: BACKGROUND_DOWNLOAD_ACTION,
		label: 'download',
		handler: backgroundDownloadModel,
		loaded,
		entry,
		ctx,
		schedule: scheduleBackground,
		okMsg: 'OK. Download started',
	});
}

/** The detached download job. Reads its whole world from the enqueue-time options. */
async function backgroundDownloadModel(ctx: ToolActionContext): Promise<ToolResponse> {
	const model = String(ctx.options.model ?? '');
	try {
		return await runModelDownload(model, ctx.options);
	} finally {
		// Belt and braces: the claim is keyed on job liveness, so this only makes
		// the model answerable again a poll earlier.
		modelJobsInFlight.delete(model);
	}
}

async function runModelDownload(
	model: string,
	options: Record<string, unknown>,
): Promise<ToolResponse> {
	const dtype = (options.dtype ?? undefined) as Record<string, string> | undefined;
	const kind = modelKindOf(options.kind);
	console.log(`[tool_transcription] downloading model '${model}' into the local store…`);
	const fileOptions =
		kind === 'diarization'
			? { commonFiles: DIARIZATION_COMMON_FILES, optionalFiles: [] as string[] }
			: {};
	const report = await downloadModel(model, dtype, { quiet: true, kind, ...fileOptions });
	if (report.ok) {
		console.log(`[tool_transcription] model '${model}' installed (${report.files.length} files)`);
		return ok({ model, files: report.files.length }, { requestId: '' });
	}
	console.error(`[tool_transcription] model download FAILED for '${model}':`, report.errors);
	// BACKGROUND job: the throw IS the job's terminal state (background.ts keeps
	// `error` on the record, which get_background_job_status serves).
	// An INTEGRITY refusal (no pin, or bytes that did not hash to it — quarantined)
	// names its own cause: the remedy is a pin or a clean source, never a retry.
	if (report.refused.length > 0) {
		throw new DedaloError('ai.model_integrity', {
			coordinates: { model, action: 'download_model' },
			message: report.refused.join('; '),
		});
	}
	throw new DedaloError('tool.action_failed', {
		coordinates: { model, action: 'download_model' },
		message: report.errors.join('; '),
	});
}

/**
 * The enqueued `kind` back as a ModelKind. A job payload crosses a process
 * boundary in shape only, but it still crosses one: an unreadable word is
 * 'unknown' (the store then answers from what is on disk) rather than silently
 * ASR, which is the assumption this whole finding is about.
 */
function modelKindOf(raw: unknown): ModelKind {
	return raw === 'asr' || raw === 'diarization' ? raw : 'unknown';
}

/** The background repair action name (allowlisted, never client-routable). */
const BACKGROUND_REPAIR_ACTION = 'background_repair_model';

/**
 * The LOCAL verdict on one present file of a PINNED model: hash it against the
 * repo's pin (no network — an air-gapped install can now verify), record the
 * digest on a match, QUARANTINE on a mismatch. Returns what happened so the
 * action can count it. Null = this file has no pin (fall back to the hub HEAD).
 */
async function verifyPinnedFile(
	store: string,
	model: string,
	file: string,
	revision: string,
): Promise<'verified' | 'quarantined' | null> {
	const pin = pinFor(model, file);
	if (pin === null) return null;
	const target = resolveStoreTarget(model, file, store);
	if (target === null) return 'quarantined'; // an unsafe name cannot be verified, so it cannot be served
	const actual = await verifiedDigest(target);
	if (actual === pin.sha256 && statSync(target).size === pin.size) {
		recordFileComplete(store, model, file, pin.size, { sha256: pin.sha256, revision });
		return 'verified';
	}
	quarantineFile(store, `${model}/${file}`);
	forgetFile(store, model, file);
	return 'quarantined';
}

/**
 * verify_model — resolve an `unverified` model into `ready`, `incomplete` or
 * `damaged`.
 *
 * A PINNED model (src/core/ai/model_pins.json) is verified LOCALLY: every
 * present file is sha256-hashed against its pin — no hub, so an air-gapped
 * install gets a real verdict — and a file whose bytes disagree is quarantined
 * and reported `damaged` (the remedy is `repair_model`, which re-fetches it at
 * the pinned revision). An UNPINNED file (an operator's own model, a variant
 * outside the pin) cannot be verified by anyone and is NAMED as such — the
 * engine does not vouch for bytes it cannot check, and it no longer asks the
 * hub for a length either: a length from a mutable head is not a verdict, and
 * the probe made this action need the network (2026-09-04 removed
 * `headContentLength`). Same admin gate as download_model. NO NETWORK: an
 * air-gapped archive gets the same verdict as a connected one.
 */
async function verifyModelAction(ctx: ToolActionContext): Promise<ToolResponse> {
	if (ctx.principal?.isGlobalAdmin !== true) {
		throw new DedaloError('perm.denied', {
			coordinates: { tool: 'tool_transcription', action: 'verify_model' },
		});
	}
	const model = String(ctx.options.model ?? '');
	const entry = await findCatalogModel(model);
	if (entry === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `Unknown model: '${model}' is not in the transcriber catalog`,
			coordinates: { model },
		});
	}

	const store = modelStoreRoot();
	const report = modelState(entry.name, entry.dtype, entry.kind);
	const revision = pinnedRevision(entry.name);
	let checked = 0;
	const unverifiable: string[] = [];
	const quarantined: string[] = [];
	for (const file of report.files) {
		if (!file.present) continue;
		const verdict =
			revision === null ? null : await verifyPinnedFile(store, entry.name, file.file, revision);
		if (verdict === 'verified') checked++;
		else if (verdict === 'quarantined') quarantined.push(file.file);
		// null: no pin for this model or file. The engine does not vouch for bytes
		// it cannot verify — the file stays `unverified`, and is NAMED, never
		// silently counted as fine (CONVENTIONS §1).
		else unverifiable.push(file.file);
	}

	const after = modelState(entry.name, entry.dtype, entry.kind);
	// A quarantined file is now ABSENT from the store, so the disk verdict reads
	// `incomplete`; the truth is stronger and names the remedy (repair): the
	// bytes were the WRONG bytes. Same state the header-plausibility check uses —
	// identical remedy, no new enum member, no client change.
	if (quarantined.length > 0) {
		console.error(
			`[tool_transcription] verify '${model}': ${quarantined.length} file(s) failed the pinned sha256 and were quarantined: ${quarantined.join(', ')}`,
		);
		return ok(
			{ state: 'damaged' satisfies ModelState, checked, unverifiable, quarantined },
			{ requestId: toolRequestId(ctx) },
		);
	}
	if (unverifiable.length > 0) {
		const note = `${unverifiable.length} file(s) have no digest pin and remain unverified`;
		console.warn(`[tool_transcription] verify '${model}': ${note}`);
		return ok(
			{ state: after.state, checked, unverifiable, quarantined, note },
			{ requestId: toolRequestId(ctx) },
		);
	}
	return ok(
		{ state: after.state, checked, unverifiable, quarantined },
		{ requestId: toolRequestId(ctx) },
	);
}

/**
 * The scheduling call `repair_model` makes, isolated behind a seam.
 *
 * Reaching this point already PROVES the catalog gate bound the requested name
 * (a name outside the catalog fails earlier). The default is the real
 * `scheduleBackground` (a live install has no other way to run a repair); tests
 * inject a spy so a KNOWN catalog name can be proven to pass the gate without
 * the real background job firing a network fetch or writing to the real store —
 * `scheduleBackground` fires the job fully detached, so nothing inside
 * `repairModelAction` itself can otherwise stop it once scheduled.
 */
export type ScheduleRepair = typeof scheduleBackground;

/**
 * MODEL JOBS IN FLIGHT — at most one download OR repair per model, process-wide.
 *
 * Both actions write the same files: a repair deletes and re-fetches them, a
 * download resumes them with `curl -C -`. Two jobs over the same paths race —
 * the second can delete a file the first has just completed, and the first can
 * record a manifest size for a file the second has already removed. With a
 * visible button and a poll that says nothing for minutes, a second click is not
 * an edge case; it is what an impatient administrator does.
 *
 * KEYED ON THE JOB, NOT ON A FLAG. The guard used to be a bare Set cleared by
 * the job's own `finally` — which never runs when the job is CANCELLED WHILE
 * STILL QUEUED (`MediaJobManager.run` finishes it 'stopped' without invoking the
 * worker at all). Cancelling a queued job is a first-class button in the jobs
 * UI, so one press left that model answering "a repair is already running"
 * forever, with no recovery short of a server restart. The claim now carries the
 * job's id and is checked against the job registry: a job that is done, failed,
 * stopped, interrupted or gone is not in flight, whoever forgot to clear what.
 *
 * A claim with NO job id (only a stubbed scheduler produces one) keeps the old
 * flag behaviour, and `releaseModelJobLock` is how a test drops it.
 */
interface ModelJobClaim {
	/** What is running, for the refusal message. */
	action: 'download' | 'repair';
	/** The media-jobs handle whose liveness IS the guard. */
	jobId?: string;
}
const modelJobsInFlight = new Map<string, ModelJobClaim>();

/** A job the registry still considers live is one the job registry can still stop. */
function isLiveJob(jobId: string): boolean {
	const record = mediaJobs.status(jobId);
	return record !== null && (record.status === 'queued' || record.status === 'running');
}

/** The claim on this model, or null — releasing a claim whose job is over. */
function modelJobInFlight(model: string): ModelJobClaim | null {
	const claim = modelJobsInFlight.get(model);
	if (claim === undefined) return null;
	if (claim.jobId !== undefined && !isLiveJob(claim.jobId)) {
		modelJobsInFlight.delete(model);
		return null;
	}
	return claim;
}

/**
 * The model is already claimed by a live job — a CONFLICT, not a caller fault.
 * The sentence names the running action, which is safe to show, so the code's
 * disclosure carries it (`tool.unsupported_target` is the public-facing half of
 * the pair; the conflict status is what the client keys on).
 */
function refuseBusyModel(model: string, claim: ModelJobClaim): never {
	throw new DedaloError('resource.conflict', {
		coordinates: { model, running_action: claim.action },
		message: `A ${claim.action} of '${model}' is already running; wait for it to finish`,
	});
}

/**
 * Release the guard for one model.
 *
 * TESTS ONLY: a stubbed scheduler returns no job handle, so there is no job
 * whose liveness could answer for it. Never call this from the engine — releasing
 * a claim whose job is still running is exactly the race it exists to prevent.
 */
export function releaseModelRepairLock(model: string): void {
	modelJobsInFlight.delete(model);
}

/**
 * repair_model — discard the files that fail their check and fetch them again.
 *
 * The remedy for the state this whole change exists to surface. Same gates as
 * download_model (global admin, catalog names only) and the same detached job,
 * so nothing new can be reached from the wire; the client polls the returned job
 * handle, so a repair that FAILS says so instead of leaving a progress line
 * standing forever.
 */
export async function repairModelAction(
	ctx: ToolActionContext,
	schedule: ScheduleRepair = scheduleBackground,
): Promise<ToolResponse> {
	if (ctx.principal?.isGlobalAdmin !== true) {
		throw new DedaloError('perm.denied', {
			coordinates: { tool: 'tool_transcription', action: 'repair_model' },
		});
	}
	const model = String(ctx.options.model ?? '');
	const entry = await findCatalogModel(model);
	if (entry === null) {
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `Unknown model: '${model}' is not in the transcriber catalog`,
			coordinates: { model },
		});
	}
	// SERVER-side, because a disabled button is not a guard: the action is on the
	// wire and two tabs reach it independently.
	const busy = modelJobInFlight(entry.name);
	if (busy !== null) refuseBusyModel(entry.name, busy);

	const loaded = await getLoadedTool('tool_transcription');
	if (loaded === undefined) {
		throw new DedaloError('tool.no_server_module', {
			coordinates: { tool: 'tool_transcription', action: 'repair_model' },
		});
	}
	return scheduleModelJob({
		action: BACKGROUND_REPAIR_ACTION,
		label: 'repair',
		handler: backgroundRepairModel,
		loaded,
		entry,
		ctx,
		schedule,
		okMsg: 'OK. Repair started',
	});
}

/**
 * Claim the model and schedule the job — the ONE place both write actions are
 * started, so the guard cannot be right in one of them and wrong in the other.
 *
 * The re-check here is not redundant: it is the half that runs with NO `await`
 * between the check and the claim, which is what makes two concurrent requests
 * impossible to interleave (the caller's earlier check only saves the work of
 * loading the tool).
 */
async function scheduleModelJob(input: {
	action: string;
	label: 'download' | 'repair';
	handler: (ctx: ToolActionContext) => Promise<ToolResponse>;
	loaded: NonNullable<Awaited<ReturnType<typeof getLoadedTool>>>;
	entry: CatalogModel;
	ctx: ToolActionContext;
	schedule: ScheduleRepair;
	okMsg: string;
}): Promise<ToolResponse> {
	const { entry, ctx } = input;
	const busy = modelJobInFlight(entry.name);
	if (busy !== null) refuseBusyModel(entry.name, busy);

	const scheduled = input.schedule(
		input.loaded,
		input.action,
		{
			permission: null,
			gatedInHandler:
				'UNGATED BY DESIGN — a BACKGROUND-ONLY spec for BACKGROUND_DOWNLOAD_ACTION / BACKGROUND_REPAIR_ACTION, both absent from apiActions and therefore unroutable from the wire. The wire-facing caller (downloadModelAction / repairModelAction) has already refused a non-isGlobalAdmin principal before scheduleModelJob is reached.',
			handler: input.handler,
		},
		{ model: entry.name, dtype: entry.dtype, kind: entry.kind },
		ctx.principal,
		ctx.userId,
	);
	// scheduleBackground THROWS `tool.background_not_allowed` for a method not
	// in BACKGROUND_RUNNABLE (P1 sweep); a returned value is the ok envelope.
	modelJobsInFlight.set(entry.name, {
		action: input.label,
		jobId: typeof scheduled.job_id === 'string' ? scheduled.job_id : undefined,
	});
	// The job handle rides as EXTENSION KEYS (the client reads them by name), so
	// it can learn that the job FAILED instead of polling the store forever.
	return ok(true, {
		requestId: toolRequestId(ctx),
		extend: {
			job_id: scheduled.job_id,
			background_job_id: scheduled.background_job_id,
		},
	});
}

/**
 * The WORLD-TOUCHING collaborator of the repair job, behind a seam.
 *
 * `backgroundRepairModel` is the only code in this subsystem that DELETES files,
 * and it is where every remedy button in both clients ends up. Gating it must not
 * mean fetching a gigabyte from a public hub, so the downloader is injectable;
 * the store itself is relocated by DEDALO_AI_MODEL_STORE, exactly as the other
 * store gates do it.
 */
export interface RepairSeams {
	readonly download?: typeof downloadModel;
}

/**
 * The non-weight files this kind of model needs, and which may legitimately be
 * absent. An UNKNOWN kind demands NONE: inventing a requirement (the ASR
 * tokenizer, for a model that may not be ASR at all) is how a healthy install
 * gets called broken, and the repair then only touches the files the store's own
 * evidence named.
 */
function commonFilesFor(kind: ModelKind): {
	common: readonly string[];
	optional: readonly string[];
} {
	if (kind === 'diarization') return { common: DIARIZATION_COMMON_FILES, optional: [] };
	if (kind === 'unknown') return { common: [], optional: [] };
	return { common: COMMON_FILES, optional: OPTIONAL_FILES };
}

/** A file that fails its own check: absent, empty, the wrong KIND, or the wrong LENGTH. */
function failsCheck(evidence: ModelFileEvidence): boolean {
	if (!evidence.present || evidence.size === 0) return true;
	if (!evidence.plausible) return true;
	return evidence.expected !== null && evidence.expected !== evidence.size;
}

interface RepairPlan {
	/** Files to delete and fetch again — EXACTLY these, by name. */
	targets: string[];
	/** Files that fail their check but must not be deleted (see planRepair). */
	refused: string[];
}

/**
 * What a repair may touch.
 *
 * TWO RULES, both learned from a way this used to be wrong:
 *
 * 1. PER FILE, never per model. It used to treat every file as suspect as soon as
 *    the model's overall state was `damaged`, so one HTML error page written over
 *    the tokenizer took the weights with it.
 * 2. NEVER DELETE WHAT CANNOT BE NAMED AGAIN. On the dtype-less path the file
 *    names come from the store itself, and when the store holds no complete
 *    weight pair there are no names — `modelFiles()` supplies fp32 PLACEHOLDERS
 *    (`report.namesKnown === false`). Deleting a weight file on that authority
 *    and re-fetching `modelFiles(undefined)` is how a 400 MB working q4 install
 *    became a ~3 GB fp32 set the browser never asks for. Refuse, and say why.
 *
 * The common files (tokenizer.json, preprocessor_config.json…) are checked here
 * too: `modelState` only evidences what the model needs to LOAD, so a corrupt
 * tokenizer used to survive a repair that then reported success.
 */
function planRepair(
	store: string,
	model: string,
	report: ModelStateReport,
	common: readonly string[],
	optional: readonly string[],
): RepairPlan {
	const targets: string[] = [];
	const refused: string[] = [];

	for (const evidence of report.files) {
		if (!failsCheck(evidence)) continue;
		if (!report.namesKnown && evidence.file.endsWith('.onnx')) {
			refused.push(evidence.file);
			continue;
		}
		targets.push(evidence.file);
	}

	for (const file of common) {
		if (targets.includes(file)) continue;
		const evidence = fileEvidence(store, model, file);
		// A model that simply does not publish this file is not broken.
		if (!evidence.present && optional.includes(file)) continue;
		if (failsCheck(evidence)) targets.push(file);
	}

	return { targets, refused };
}

/** Delete one file and drop the manifest's (now stale) claim about it. */
function discardFile(store: string, model: string, file: string): void {
	const path = join(store, model, file);
	try {
		if (existsSync(path)) rmSync(path);
	} catch (error) {
		console.error(`[tool_transcription] could not remove '${path}' during repair:`, error);
	}
	// The manifest's claim about a deleted file is stale; dropping it makes the
	// next fetch ask the hub for the length again instead of trusting the record
	// that let the truncation through.
	forgetFile(store, model, file);
}

/**
 * Did the repair actually work? Re-check EVERY file it touched, not just the
 * ones the load path needs — reporting a success while a corrupt file survives
 * is the one outcome this subsystem forbids.
 */
function repairVerdict(input: {
	model: string;
	dtype?: Record<string, string>;
	kind: ModelKind;
	store: string;
	common: readonly string[];
	optional: readonly string[];
	plan: RepairPlan;
	download: DownloadReport;
}): ToolResponse {
	const { model, store, plan, download } = input;
	const after = modelState(model, input.dtype, input.kind);
	const stillFailing = plan.targets.filter((file) => {
		const evidence = fileEvidence(store, model, file);
		if (!evidence.present && input.optional.includes(file)) return false;
		return failsCheck(evidence);
	});

	if (download.ok && isRunnableState(after.state) && stillFailing.length === 0) {
		console.log(
			`[tool_transcription] OK. Model repaired: ${model} — ${plan.targets.length} file(s) re-fetched and re-checked (weights, config and ${input.common.length} common file(s)); state: ${after.state}`,
		);
		return ok({ model, state: after.state, repaired: plan.targets.length }, { requestId: '' });
	}

	const errors = [...download.errors];
	if (stillFailing.length > 0) {
		errors.push(`still failing after repair: ${stillFailing.join(', ')}`);
	}
	if (errors.length === 0) errors.push(`state after repair: ${after.state}`);
	console.error(`[tool_transcription] model repair FAILED for '${model}':`, errors);
	// BACKGROUND job — the throw is the terminal state (see runModelDownload).
	throw new DedaloError('tool.action_failed', {
		coordinates: { model, action: 'repair_model' },
		message: errors.join('; '),
	});
}

/**
 * The detached repair job: delete exactly the files that fail their check, fetch
 * back exactly those, and re-check them before claiming anything.
 */
export async function backgroundRepairModel(
	ctx: ToolActionContext,
	seams: RepairSeams = {},
): Promise<ToolResponse> {
	const model = String(ctx.options.model ?? '');
	try {
		return await runModelRepair(model, ctx.options, seams);
	} finally {
		// Belt and braces: the claim is keyed on job liveness (see
		// modelJobsInFlight), so this only frees the model a poll earlier.
		modelJobsInFlight.delete(model);
	}
}

async function runModelRepair(
	model: string,
	options: Record<string, unknown>,
	seams: RepairSeams,
): Promise<ToolResponse> {
	const dtype = (options.dtype ?? undefined) as Record<string, string> | undefined;
	const kind = modelKindOf(options.kind);
	const store = modelStoreRoot();
	const { common, optional } = commonFilesFor(kind);
	const plan = planRepair(store, model, modelState(model, dtype, kind), common, optional);

	if (plan.refused.length > 0) {
		// The remedy has to fit the reason. "Re-import the tools registry so the
		// catalog declares the dtype" is the fix when the KIND is known and only
		// the quantisation is missing; it cannot help when the catalog declares a
		// kind this build cannot read, because then the file shape itself is a
		// guess and no dtype would settle it.
		const remedy =
			kind === 'unknown'
				? "this install's catalog declares a model kind this engine does not recognise, so the files it needs cannot be named"
				: "this install's catalog declares no quantisation for it and the store holds no complete weight pair";
		const advice =
			kind === 'unknown'
				? 'Upgrade the engine or correct the catalog entry, or seed the store directly.'
				: "Re-import the tools registry so the catalog declares the model's dtype, or seed the store directly.";
		const msg = `Repair refused for '${model}': ${remedy}, so ${plan.refused.join(', ')} cannot be named to fetch back. Deleting them would destroy what cannot be restored. ${advice}`;
		console.error(`[tool_transcription] ${msg}`);
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: msg,
			coordinates: { model, refused: plan.refused.join(', ') },
		});
	}

	if (plan.targets.length === 0) {
		console.log(
			`[tool_transcription] OK. Nothing to repair: '${model}' passes every check (weights, config and ${common.length} common file(s))`,
		);
		return ok(
			{ model, repaired: 0, state: modelState(model, dtype, kind).state },
			{ requestId: '' },
		);
	}

	console.log(
		`[tool_transcription] repairing model '${model}': ${plan.targets.length} file(s) — ${plan.targets.join(', ')}`,
	);
	for (const file of plan.targets) discardFile(store, model, file);

	const download = await (seams.download ?? downloadModel)(model, dtype, {
		quiet: true,
		store,
		kind,
		// EXACTLY what was removed: see DownloadOptions.files.
		files: plan.targets,
	});

	return repairVerdict({ model, dtype, kind, store, common, optional, plan, download });
}

export const tool: ToolServerModule = {
	name: 'tool_transcription',
	// Its media / transcription / status roles come ONLY from the caller's
	// properties.tool_config.tool_transcription ddo_map (no default map): offered on a
	// bare av/image/pdf (a user avatar, a gallery image) it opened on null roles and
	// crashed (`null.model`). Offered where it is configured (rsc29/35/37, oh81).
	isAvailable: (context) => context.hasToolConfig,
	// `permission: null` throughout, because the target of every media action is a
	// NESTED ddo (or a model name) or a (section, component, record) triple the
	// declarative kinds cannot express on BOTH halves (build_subtitles_file gates
	// the transcript AND its related AV). Each string below is the P2-8(a) census entry
	// (test/unit/tool_permission_census_tripwire.test.ts) naming the in-handler gate.
	apiActions: {
		get_model_sources: {
			permission: null,
			gatedInHandler:
				'UNGATED — no authorization check: the answer is install configuration (AI_MODEL_URL_PREFIX, modelHubAllowed(), modelStoreAvailable()) plus the catalog and the model store on disk. No record is addressed and nothing is written; reachable by any authenticated user granted tool_transcription.',
			handler: getModelSources,
		},
		download_model: {
			permission: null,
			gatedInHandler:
				'ctx.principal.isGlobalAdmin — the first statement of downloadModelAction, throwing perm.denied otherwise. A model download is an install-wide, network-touching write to the shared model store, so it is admin-only rather than section-scoped.',
			handler: downloadModelAction,
		},
		verify_model: {
			permission: null,
			gatedInHandler:
				'ctx.principal.isGlobalAdmin — the first statement of verifyModelAction, throwing perm.denied otherwise. It reports the install-wide model state, not any record.',
			handler: verifyModelAction,
		},
		repair_model: {
			permission: null,
			gatedInHandler:
				'ctx.principal.isGlobalAdmin — the first statement of repairModelAction, throwing perm.denied otherwise. Repair DELETES and re-downloads files in the shared model store.',
			handler: repairModelAction,
		},
		create_transcribable_audio_file: {
			permission: null,
			gatedInHandler:
				'gateRecord(media_ddo, ctx, read, 2) — the WRITE DOOR (authorizeRecordAccess) in READ mode on the LIFTED media_ddo: the SECTION at WRITE (2 — the shared per-record WAV, the same level as its delete), the (section, component) pair at level 1 (component_tipo REQUIRED — the WAV is a derivative of the AV, the level every WAV-deriving path asks), the record scope — the first statement, before the WAV is built from the grant.',
			handler: createTranscribableAudioFile,
		},
		delete_transcribable_audio_file: {
			permission: null,
			gatedInHandler:
				'gateRecord(media_ddo, ctx, read, 2) — the write door on the lifted media_ddo: the SECTION at WRITE (2 — the shared per-record WAV is unlinked for every user of the record, so a read-only viewer may not), the AV pair at READ (1), the scope — the first statement, before the WAV is unlinked.',
			handler: deleteTranscribableAudioFile,
		},
		automatic_transcription: {
			permission: null,
			gatedInHandler:
				'gateRecord(transcription_ddo, ctx, write) on the WRITE target (component_tipo REQUIRED) plus gateRecord(media_ddo, ctx, read) on the media SOURCE (TOOLS-06) — both the write door (section floor, the pair, the scope), UNCONDITIONAL and before validation, the provider lookup and any ASR call. The background save re-runs the door (authorizeRecordAccess) before writing.',
			handler: automaticTranscription,
		},
		check_server_transcriber_status: {
			permission: null,
			gatedInHandler:
				'gateRecord(media_ddo, ctx, read) — the write door in READ mode (section floor, the component read grant, the scope), UNCONDITIONAL and before validation: a ddo without section_tipo is a gate refusal, never an ungated poll.',
			handler: checkServerTranscriberStatus,
		},
		build_subtitles_file: {
			permission: null,
			gatedInHandler:
				'gateRecord(text_area, ctx, write) on (section_tipo, component_tipo, section_id) and then gateRecord(related AV, ctx, read) — the write door twice (write on the transcript it derives the VTT from, read on the AV source), UNCONDITIONAL, before the record is read and before the VTT is written into the AV media tree.',
			handler: buildSubtitlesFile,
		},
	},
	// Background-only actions: allowlisted here, absent from apiActions
	// (unroutable from the wire) — PHP BACKGROUND_RUNNABLE.
	backgroundRunnable: [
		BACKGROUND_POLL_ACTION,
		BACKGROUND_DOWNLOAD_ACTION,
		BACKGROUND_REPAIR_ACTION,
	],
	// All three wait on the ASR sidecar, so they spend the transcription budget
	// and never the media one — a poll loop must not cost a transcode a slot
	// (PERF-11 lane declaration).
	backgroundLanes: {
		[BACKGROUND_POLL_ACTION]: 'transcription',
		[BACKGROUND_DOWNLOAD_ACTION]: 'transcription',
		[BACKGROUND_REPAIR_ACTION]: 'transcription',
	},
};
