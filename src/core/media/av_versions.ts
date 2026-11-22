/**
 * AV DERIVATIVE ENCODER — the ONE place an av quality tier is produced.
 *
 * Two callers, one encoder:
 *  - INGEST (`ingest/process_uploaded_file.ts` → submitAvTranscode): after an
 *    upload, build the default quality + the audio tier.
 *  - THE TOOL (`tools/versions.ts` → build_version, the media-versions panel's
 *    gear): build the ONE quality tier the operator asked for.
 *
 * The tool path used to call `submitAvTranscode` directly, which knows only the
 * default quality — so a click on 1080/720/576/240 re-encoded 404 instead, the
 * requested tier never appeared on disk, and the panel blinked "Processing"
 * forever polling for a file nobody was building. PHP built `$quality`
 * (component_av::build_version → Ffmpeg::get_setting_name($source, $quality)).
 *
 * Source resolution is PHP's (component_av::build_version :1470): the ORIGINAL,
 * falling back to the default-quality file when the box has no original. A tier
 * is never built from itself.
 */

import { existsSync } from 'node:fs';
import { AUDIO_TR_QUALITY, assertValidQuality, type MediaTypeSpec } from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { writeAtomically } from './atomic.ts';
import { avComponentTarget } from './av_component_claim.ts';
import {
	applyFaststart,
	extractAudio,
	type FaststartOutcome,
	probeStreams,
	standardFromFps,
	transcodeTwoPass,
} from './engine/ffmpeg.ts';
import { getFfmpegProfile, settingName } from './engine/ffmpeg_profiles.ts';
import type { SpawnOptions } from './engine/spawn.ts';
import { scanContextFromItem, scanFilesInfo } from './files_info.ts';
import { type JobTarget, type JobTargetClaim, mediaJobs } from './jobs.ts';
import { buildMediaLocation, type MediaIdentity, type MediaPathOptions } from './path.ts';
import { resolveMasterSource } from './processing.ts';
import { readStoredMediaItems } from './tool_support.ts';
import { reconcileStoredFilesInfo } from './tools/files_info_persist.ts';

/** 16x9 vs 4x3 from dimensions (PHP get_aspect_ratio). */
function pickAspect(width?: number, height?: number): '16x9' | '4x3' | null {
	if (!width || !height) return null;
	const ratio = width / height;
	return ratio > 1.5 ? '16x9' : '4x3';
}

/** What the source file's streams say about the encode (PHP get_setting_name inputs). */
export interface AvSourceProfile {
	standard: 'pal' | 'ntsc';
	aspect: '16x9' | '4x3' | null;
	hasAudio: boolean;
	hasVideo: boolean;
	/**
	 * Source length, for the encode's percentage (`engine/ffmpeg_progress.ts`).
	 * Null when no stream declares one — a real case for some containers — and
	 * then the job reports an INDETERMINATE bar rather than a made-up number.
	 */
	durationSeconds: number | null;
}

/**
 * Probe the source once; both encode branches read the result.
 *
 * A NULL probe is a FAILED probe, never an empty source: `probeStreams` returns
 * null only when ffprobe's output would not parse (a killed or crashed probe) —
 * a genuinely stream-less file still answers `{"streams":[]}`. Guessing from it
 * would silently narrow the encode: no audio stream detected ⇒ the audio tier is
 * SKIPPED, and an oral-history interview whose whole value is its audio would be
 * transcoded to a silent video with nothing anywhere saying why.
 */
export async function probeAvSource(source: string): Promise<AvSourceProfile> {
	const probe = await probeStreams(source);
	if (probe === null) {
		throw new Error(`ffprobe could not read the streams of ${source} — refusing to guess`);
	}
	const video = probe?.streams?.find((entry) => entry.codec_type === 'video');
	return {
		standard: standardFromFps(video?.avg_frame_rate),
		aspect: pickAspect(video?.width, video?.height),
		hasAudio: probe?.streams?.some((entry) => entry.codec_type === 'audio') ?? false,
		hasVideo: video !== undefined,
		durationSeconds: longestStreamDuration(probe?.streams),
	};
}

/**
 * The longest declared stream duration, in seconds — the encode's denominator.
 * The LONGEST, not the video stream's: an audio tier is extracted from a track
 * that may outlast the video, and a bar that hits 100% with minutes still to run
 * is the frozen-70% problem in a new costume.
 */
function longestStreamDuration(streams?: { duration?: string }[]): number | null {
	let longest: number | null = null;
	for (const stream of streams ?? []) {
		const seconds = Number(stream.duration);
		if (!Number.isFinite(seconds) || seconds <= 0) continue;
		if (longest === null || seconds > longest) longest = seconds;
	}
	return longest;
}

/** Whether a quality is one of the audio-only tiers (no video pass). */
function isAudioTier(quality: string): boolean {
	return quality === 'audio' || quality === AUDIO_TR_QUALITY;
}

/**
 * The result of encoding ONE tier. `skipped` is a REASON, never a silent no-op:
 * ingest tolerates both (a video-only source has no audio to extract; a tier
 * outside the profile table is not buildable on this install), while the tool
 * path turns either into a loud failure the operator can read.
 *
 * `faststart` reports the moov relocation for video tiers (null for the audio
 * extraction, which PHP never faststarted). A `faststart.error` NEVER fails the
 * encode — the file is sound, just not progressive — but every caller surfaces
 * it, because an unreported degradation is how this step went missing for a
 * whole release.
 */
export type AvEncodeOutcome =
	| { built: string; faststart: FaststartOutcome | null }
	| { skipped: 'no_profile' | 'no_audio_stream' };

/**
 * Encode one av quality tier from `source`. Video tiers run the two-pass x264
 * profile for `<quality>_<standard>[_<aspect>]` and then relocate the moov atom
 * (PHP's qt-faststart step); audio tiers extract. Output is atomic (temp +
 * rename) and the two-pass stats scratch is removed.
 *
 * NOTHING IS PUBLISHED UNTIL IT IS PROVEN SOUND (audit 2026-08 B2). Both tiers
 * go through `writeAtomically` (atomic.ts): the encode throws on a
 * killed/timed-out/non-zero pass, the producer verifies its own output is
 * non-empty, the moov relocation runs on the temp, and only then does the rename
 * replace whatever was at `target`. A failure leaves the PREVIOUS derivative
 * exactly as it was — for a heritage master that is the difference between
 * "rebuild this tier" and "this recording is silently truncated forever".
 *
 * `spawnOptions` overrides the spawn policy; left empty (as every job runner
 * leaves it) the producers apply their own — an INACTIVITY cap, never a
 * wall-clock budget, because an hour-long interview's two-pass encode
 * legitimately outruns any constant (engine/ffmpeg.ts PRODUCER_IDLE_TIMEOUT_MS).
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): requires the ffmpeg / ImageMagick
 * BINARIES and MUTATES THE REAL MEDIA TREE, so no scratch surface can contain a
 * run. The gateable content is the pure argv/profile builders in these files,
 * gated in test/unit/tier1_media_argv_native.test.ts.
 */
export async function encodeAvQuality(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	quality: string,
	source: string,
	profile: AvSourceProfile,
	spawnOptions: SpawnOptions = {},
	onFraction?: (fraction: number) => void,
): Promise<AvEncodeOutcome> {
	const target = buildMediaLocation(
		spec,
		identity,
		quality,
		spec.defaultExtension,
		pathOpts,
	).absolutePath;

	if (isAudioTier(quality)) {
		// A silent/video-only source makes ffmpeg emit "Output file does not
		// contain any stream" and exit non-zero — a skip, not a failure.
		if (!profile.hasAudio) return { skipped: 'no_audio_stream' };
		// `extractAudio` is atomic in its own right (it is also called with a SERVED
		// path by tools/transcription.ts), so there is no temp to hand-roll here.
		await extractAudio(
			source,
			target,
			quality === AUDIO_TR_QUALITY ? 'audio_tr' : 'audio',
			spawnOptions,
		);
		return { built: target, faststart: null };
	}

	return await encodeVideoTier({
		spec,
		identity,
		quality,
		source,
		profile,
		spawnOptions,
		onFraction,
		target,
	});
}

/**
 * The VIDEO half of `encodeAvQuality` — two-pass transcode, moov relocation,
 * atomic publish.
 *
 * Split out when the progress plumbing pushed `encodeAvQuality` over its frozen
 * complexity ceiling. The seam is the honest one anyway: the audio tier is an
 * extraction with no profile, no passes and no faststart, so the two branches
 * shared only their name.
 */
async function encodeVideoTier(input: {
	spec: MediaTypeSpec;
	identity: MediaIdentity;
	quality: string;
	source: string;
	profile: AvSourceProfile;
	spawnOptions: SpawnOptions;
	onFraction?: (fraction: number) => void;
	target: string;
}): Promise<AvEncodeOutcome> {
	const { identity, quality, source, profile, spawnOptions, onFraction, target } = input;

	const profileName = settingName(quality, profile.standard, profile.aspect);
	const ffmpegProfile = getFfmpegProfile(profileName);
	if (ffmpegProfile === null) return { skipped: 'no_profile' };

	// `writeAtomically` creates the tier's directory (av/576/<bucket>/) before the
	// producer runs — ffmpeg pass 1 writes its statistics file beside the temp, so
	// without it the encode dies with "ratecontrol_init: can't open stats file"
	// and NO derivative is ever produced — and its `finally` sweeps the temp on
	// every failure path.
	let faststart: FaststartOutcome | null = null;
	await writeAtomically(target, async (temp) => {
		await transcodeTwoPass(profileName, source, temp, spawnOptions, {
			durationSeconds: profile.durationSeconds,
			onFraction,
		});
		// PHP's `nice -n 19 <qt-faststart> <tmp> <target>` (class.Ffmpeg.php:782),
		// on the temp: the rename writeAtomically does is the one publication step.
		faststart = await applyFaststart(temp, { format: ffmpegProfile.force, ...spawnOptions });
		if (faststart.error !== null) {
			console.error(
				`[media] av ${identity.sectionTipo}/${identity.sectionId}/${identity.componentTipo} '${quality}': ${faststart.error}`,
			);
		}
	});
	if (faststart === null) {
		// The producer ran to completion without recording an outcome, which cannot
		// happen — but a null here would report a derivative whose moov position
		// nobody established, and an unreported degradation is how the faststart
		// step went missing for a whole release.
		throw new Error(`${profileName}: the encode published no faststart outcome for ${target}`);
	}
	return { built: target, faststart };
}

/**
 * Resolve the file an av derivative is built FROM (PHP component_av::
 * build_version :1470): the original, else the default-quality file. Returns
 * null when neither is on this box.
 *
 * `targetQuality` is excluded from the fallback — a tier is never built from
 * itself (re-encoding 404 over 404 through a lossy profile is destruction, not
 * a build).
 */
export function resolveAvBuildSource(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	targetQuality: string,
	rawExtension?: string | null,
): string | null {
	const original = resolveMasterSource(spec, identity, pathOpts, rawExtension);
	if (original !== null) return original;
	if (targetQuality === spec.defaultQuality) return null;
	for (const extension of [spec.defaultExtension, ...spec.allowedExtensions]) {
		const candidate = buildMediaLocation(
			spec,
			identity,
			spec.defaultQuality,
			extension,
			pathOpts,
		).absolutePath;
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Write the finished transcode's files_info back onto the record.
 *
 * A transcode ends long after the request that started it returned, so the
 * caller's own persist could only record the ORIGINAL — the derivatives it
 * produced (the default quality, the extracted audio) never reached the matrix,
 * and unlike a read-time-rescanned emit, everything that consumes the STORED
 * index (diffusion, publication, export, tool_media_versions) kept seeing an
 * av record that owned nothing but its source file.
 *
 * The stored items are RE-READ under the row lock inside
 * `reconcileStoredFilesInfo`, never closed over: the request's snapshot is long
 * stale, and both the caller's own persist and a concurrent save can commit on
 * this key while ffmpeg runs. Only the ONE cue the scan needs — the stored
 * normalized names / external source — is read (unlocked) beforehand; a stale
 * cue at worst costs an index entry, it cannot revert someone's write.
 *
 * No stored item ⇒ the reconcile no-ops (it never mints — the passive-scan rule:
 * a transcode must not create a stored value for a component that has none; the
 * operator's explicit sync_files repair is the one path that may). That decision
 * is left to the reconcile, INSIDE the lock — an unlocked pre-check here could
 * read "no item" a moment before the caller's own persist created one, and skip
 * the write-back this whole path exists for.
 */
export async function persistTranscodedFilesInfo(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): Promise<void> {
	const items = await readStoredMediaItems(
		identity.sectionTipo,
		identity.sectionId,
		identity.componentTipo,
	);
	const item = items.find((entry) => (entry.lang ?? null) === identity.lang) ?? items[0];
	const filesInfo = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(item));
	await reconcileStoredFilesInfo({
		sectionTipo: identity.sectionTipo,
		sectionId: identity.sectionId,
		componentTipo: identity.componentTipo,
		lang: identity.lang,
		freshFilesInfo: filesInfo,
	});
}

/**
 * Run the write-back and report its failure INSTEAD of failing the job: the
 * derivatives really are on disk, and reporting the transcode as errored would
 * send the client back to a re-transcode it does not need. Still loud
 * (console.error + a `persist_error` in the payload) because a record that does
 * not know its own files is exactly the bug this exists to fix.
 */
async function persistOrReport(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): Promise<string | null> {
	try {
		await persistTranscodedFilesInfo(spec, identity, pathOpts);
		return null;
	} catch (error) {
		const message = (error as Error).message;
		console.error(
			`[media jobs] av_transcode ${identity.sectionTipo}/${identity.sectionId}/${identity.componentTipo}: files_info write-back failed: ${message}`,
		);
		return message;
	}
}

/**
 * The target the INGEST transcode occupies — the default tier, plus the audio
 * tier the same job writes. ONE derivation, read by submitAvTranscode and by the
 * upload's claim (process_uploaded_file.ts), so the upload refusal and the job
 * can never disagree about which tiers are busy.
 *
 * The job's target is the DEFAULT tier: that is the one an operator watches for
 * after an upload, and the one whose empty cell in the versions panel started
 * this. The audio tier rides along in the same job (it always has) and is named
 * in `also_qualities` rather than given a target of its own — one job, one
 * target, so the duplicate guard and the panel agree on what is busy. And it is
 * COMPONENT-scoped (`scope`): one build per component, as v6's build lock —
 * the upload claim, this job and every per-quality build exclude each other.
 */
export function avIngestTarget(spec: MediaTypeSpec, identity: MediaIdentity): JobTarget {
	return {
		section_tipo: identity.sectionTipo,
		section_id: identity.sectionId,
		component_tipo: identity.componentTipo,
		lang: identity.lang ?? null,
		quality: spec.defaultQuality,
		label: spec.defaultQuality,
		// The audio tier is built by THIS SAME JOB, so it must be blocked
		// too. Without it the guard covered the default tier and left audio
		// open — a click on the audio gear mid-ingest started a second
		// ffmpeg writing the very file this job was about to produce.
		also_qualities: spec.qualities.includes('audio') ? ['audio'] : [],
		// ONE build per component (v6 build lock): the upload claim and this
		// job exclude every per-quality build of the component, and vice versa.
		scope: 'component',
	};
}

/**
 * Submit the INGEST transcode: the default quality (two-pass) + the audio tier,
 * then the files_info write-back. Returns the job id.
 *
 * EXCLUSIVE (A1-01): refused with `media.build_running` while the component has
 * any live build — a per-quality build of any tier or another upload's claim —
 * so no door can start a second build of one component. `claim` is the upload's own hold on
 * the target (processUploadedFile), adopted by the job in the same synchronous
 * step.
 */
export function submitAvTranscode(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	rawExtension: string,
	userId?: number,
	claim?: JobTargetClaim,
): string {
	const record = mediaJobs.submit(
		'av_transcode',
		async ({ onProgress, onData }) => {
			const source = resolveMasterSource(spec, identity, pathOpts, rawExtension);
			if (source === null) {
				throw new DedaloError('media.file_not_found', {
					message: 'AV original not found for transcode',
					publicMessage: 'AV original not found for transcode',
				});
			}
			const profile = await probeAvSource(source);
			const created: string[] = [];

			// TIER-SPLIT PROGRESS. The video encode owns 0-85% and the audio
			// extraction 85-95%, each fed by ffmpeg's own -progress stream rather
			// than by a step marker. Before this the bar sat at a hand-written 70
			// for most of an hour on a long master, which reads as a wedged job.
			const publishTier = (tier: string): ((fraction: number) => void) => {
				return (fraction: number): void => {
					const base = tier === 'audio' ? 85 : 0;
					const span = tier === 'audio' ? 10 : 85;
					onProgress(base + fraction * span);
					onData({ msg: `Encoding ${tier}`, quality: tier, is_running: true });
				};
			};

			const video = await encodeAvQuality(
				spec,
				identity,
				pathOpts,
				spec.defaultQuality,
				source,
				profile,
				{},
				publishTier(spec.defaultQuality),
			);
			if ('built' in video) created.push(video.built);
			onProgress(85);

			if (spec.qualities.includes('audio')) {
				const audio = await encodeAvQuality(
					spec,
					identity,
					pathOpts,
					'audio',
					source,
					profile,
					{},
					publishTier('audio'),
				);
				if ('built' in audio) created.push(audio.built);
			}
			onProgress(95);

			const persistError = await persistOrReport(spec, identity, pathOpts);
			onProgress(100);
			return {
				created,
				persist_error: persistError,
				faststart_error: faststartErrorOf(video),
			};
		},
		{
			// ffmpeg work — the media budget, by declaration (PERF-11).
			lane: 'media',
			userId,
			target: avIngestTarget(spec, identity),
			exclusive: true,
			...(claim === undefined ? {} : { claim }),
		},
	);
	return record.id;
}

/** The degradation an outcome carries, for the job payload (null when sound). */
function faststartErrorOf(outcome: AvEncodeOutcome): string | null {
	return 'built' in outcome ? (outcome.faststart?.error ?? null) : null;
}

/**
 * Why a per-quality build cannot even be submitted (the operator-facing reason).
 *
 * A THIN `DedaloError` family (errors/families.ts pattern): it adds no
 * behaviour, it only FORCES the `media.av_build_refused` code, so every
 * pre-flight refusal converts to the same 400 and the panel renders the reason
 * (the code is public-disclosure and every sentence below is engine data — a
 * tier name, a profile name — never a path or a raw caller string). Existing
 * `instanceof AvBuildRefused` catch sites keep working unchanged.
 */
export class AvBuildRefused extends DedaloError {
	constructor(reason: string) {
		super('media.av_build_refused', { message: reason, publicMessage: reason });
		this.name = 'AvBuildRefused';
	}
}

/**
 * EVERY refusal knowable BEFORE a job id exists, in one place.
 *
 * The panel shows "Processing" the moment it gets a job id, so a refusal that
 * can be known now must be raised now — an accepted job that dies two seconds
 * later is the shape of the bug this whole path replaces. Extracted from
 * `submitAvVersionBuild` when the duplicate guard pushed it over the frozen
 * complexity ceiling; the seam is honest, since everything here is a question
 * asked before any work starts.
 *
 * Returns the two things the encode needs and the pre-flight already resolved,
 * so nothing is probed twice.
 */
async function preflightAvBuild(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	quality: string,
	target: JobTarget,
	rawExtension?: string | null,
): Promise<{ source: string; profile: AvSourceProfile }> {
	if (spec.model !== 'component_av') {
		throw new AvBuildRefused('build_version: not an av component');
	}
	assertValidQuality(spec, quality);
	if (quality === spec.originalQuality) {
		throw new AvBuildRefused('build_version: the original is the source, it cannot be built');
	}
	// ONE BUILD PER COMPONENT (v6 build lock, A1-01). Two operators looking at
	// the same record — or one operator whose upload is still transcoding — could
	// each start an encode reading the same master and writing beside it; an
	// upload landing mid-build replaces the master under ffmpeg. Asked FIRST,
	// before the source is resolved or probed: a busy component is the answer,
	// whatever else is true. The same code as the upload refusal — one condition,
	// one answer — and the exclusive submit below is the half that cannot
	// interleave. See MediaJobManager.hasLiveJobForTarget for why this is
	// in-memory where diffusion's equivalent is a DB constraint.
	if (mediaJobs.isOccupied(target)) {
		throw new DedaloError('media.build_running', {
			message: `build_version: a build is already running for this component ('${quality}' asked)`,
			coordinates: { quality },
		});
	}

	const source = resolveAvBuildSource(spec, identity, pathOpts, quality, rawExtension);
	if (source === null) {
		throw new AvBuildRefused(
			`build_version: no original and no ${spec.defaultQuality} file to build '${quality}' from`,
		);
	}
	const profile = await probeAvSource(source);
	assertTierIsEncodable(quality, profile);
	return { source, profile };
}

/** The last pre-flight question: can THIS source produce THIS tier at all? */
function assertTierIsEncodable(quality: string, profile: AvSourceProfile): void {
	if (isAudioTier(quality)) {
		if (!profile.hasAudio) {
			throw new AvBuildRefused(`build_version: the source has no audio stream ('${quality}')`);
		}
		return;
	}
	const profileName = settingName(quality, profile.standard, profile.aspect);
	if (getFfmpegProfile(profileName) === null) {
		throw new AvBuildRefused(`build_version: no encode profile '${profileName}'`);
	}
}

/**
 * Submit the TOOL's per-quality build (PHP build_version($quality, async)).
 *
 * PRE-FLIGHT, before the job id is handed to the client: the quality must be
 * valid, a source file must exist, and the encode must be possible for THIS
 * source (a profile for the tier, an audio stream for an audio tier). The panel
 * shows "Processing" the moment it gets a job id, so a refusal that can be known
 * now must be raised now — an accepted job that dies two seconds later is the
 * shape of the bug this replaces. Throws `AvBuildRefused` (or `media.build_running`
 * when the component already has a build — one per component); the tool handler
 * turns that into the refusal envelope.
 */
export async function submitAvVersionBuild(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	quality: string,
	rawExtension?: string | null,
	userId?: number,
): Promise<string> {
	// ONE build per component (v6 build lock): a build of ANY tier excludes the
	// upload, the ingest transcode, every other tier's build and every av
	// operation (avComponentTarget is component-scoped).
	const target: JobTarget = avComponentTarget(identity, quality);
	const { source, profile } = await preflightAvBuild(
		spec,
		identity,
		pathOpts,
		quality,
		target,
		rawExtension,
	);

	const record = mediaJobs.submit(
		'av_transcode',
		async ({ onProgress, onData }) => {
			onProgress(5);
			const outcome = await encodeAvQuality(
				spec,
				identity,
				pathOpts,
				quality,
				source,
				profile,
				{},
				// 5-90% is the encode itself; the persist owns the rest.
				(fraction) => {
					onProgress(5 + fraction * 85);
					onData({ msg: `Encoding ${quality}`, quality, is_running: true });
				},
			);
			// Unreachable via the pre-flight above unless the source changed under us
			// mid-flight — then it IS the job's failure, and the panel reads the reason.
			if (!('built' in outcome)) {
				throw new Error(`build_version: '${quality}' not built (${outcome.skipped})`);
			}
			onProgress(90);
			const persistError = await persistOrReport(spec, identity, pathOpts);
			onProgress(100);
			return {
				created: [outcome.built],
				quality,
				persist_error: persistError,
				faststart_error: faststartErrorOf(outcome),
			};
		},
		// ffmpeg work — the media budget, by declaration (PERF-11). EXCLUSIVE: the
		// pre-flight's isOccupied is a question asked before an await
		// (the probe); this is the answer that cannot interleave (A1-01).
		{ lane: 'media', userId, target, exclusive: true },
	);
	return record.id;
}
