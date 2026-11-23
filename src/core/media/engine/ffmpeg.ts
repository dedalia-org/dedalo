/**
 * FFMPEG ADAPTER — argv recipes ported from PHP class.Ffmpeg.php.
 *
 * Pure `build*Argv` builders (unit-tested against the PHP command recipes) +
 * `run*`/`probe*` executors over the spawn discipline. The two-pass x264 chain
 * that PHP wrote to a self-deleting `.sh` becomes two supervised spawns here (no
 * shell, no temp script), and `transcodeTwoPass` owns the passlog scratch it
 * gives them.
 *
 * TWO KINDS OF SPAWN, and the distinction is load-bearing (audit 2026-08 B2):
 * a PRODUCER writes a file and goes through `runProducer` — the inactivity
 * timeout policy, ffmpeg's `-progress` liveness channel, `assertSpawnOk` and an
 * output post-condition; a PROBE reads and may answer "unknown". Every producer
 * stages through `atomic.ts`, so a served path is only ever replaced by a file
 * that was proven sound.
 *
 * PHP anchors: build_av_alternate_command (:491), create_posterframe (:1075),
 * conform_header (:1346), convert_to_dedalo_av (:1497), build_fragment (:1200),
 * get_media_attributes (:1585), get_media_streams (:1651), get_audio_codec (:1722).
 */

import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { config } from '../../../config/config.ts';
import { withTempSibling, writeAtomically } from '../atomic.ts';
import { assertJobHold } from '../job_scope.ts';
import { withAvSlot } from './admission.ts';
import { resolveFaststart } from './binaries.ts';
import { type FfmpegProfile, getFfmpegProfile } from './ffmpeg_profiles.ts';
import { chainStdout, createFfmpegProgressReader } from './ffmpeg_progress.ts';
import {
	assertSpawnOk,
	describeSpawnFailure,
	runBinary,
	type SpawnOptions,
	type SpawnResult,
} from './spawn.ts';

function ffmpeg(): string {
	return config.media.binaries.ffmpeg;
}
function ffprobe(): string {
	return config.media.binaries.ffprobe;
}

/**
 * HOW LONG A PRODUCER MAY BE SILENT before it is declared wedged (audit 2026-08
 * B2's remediation). Ten minutes is the number the pre-2026-08 cap used, but it
 * now measures the wrong thing on purpose: SILENCE, not work.
 *
 * The old cap was a wall-clock budget, and the archive this engine serves holds
 * hour-long oral-history interviews — a two-pass x264 encode of one legitimately
 * exceeds any constant, so a budget cannot be both safe for a wedge and safe for
 * the content. An inactivity window can: every ffmpeg run here carries
 * `-progress pipe:1`, which emits a block roughly twice a second for as long as
 * the process is doing anything at all, so ten minutes of total silence is ~1200x
 * the expected gap. A live encode of any duration passes; a wedged one dies.
 */
export const PRODUCER_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The spawn policy for a command that PRODUCES A FILE. Never a total wall-clock
 * cap — see the constant above and `engine/spawn.ts`'s header. A caller may still
 * state its own policy (the gates do, to drive a kill in milliseconds); passing
 * one suppresses the default rather than colliding with it, because `runBinary`
 * refuses both caps at once.
 */
export function producerSpawnOptions(options: SpawnOptions = {}): SpawnOptions {
	if (options.timeoutMs !== undefined || options.idleTimeoutMs !== undefined) return options;
	return { ...options, idleTimeoutMs: PRODUCER_IDLE_TIMEOUT_MS };
}

/**
 * ffmpeg's own liveness channel, injected at RUN time so the `build*Argv`
 * recipes below stay verbatim PHP ports (they are unit-tested as such). `-progress
 * pipe:1` writes a key=value block to stdout every stats period REGARDLESS of
 * `-loglevel`, which matters because pass 1 is `-loglevel error` and would
 * otherwise be silent for hours — indistinguishable from a wedge.
 */
function withProgress(argv: readonly string[]): string[] {
	return [argv[0] as string, '-progress', 'pipe:1', ...argv.slice(1)];
}

/**
 * THE ONE SPAWN for every media command that writes a file. It applies the
 * producer timeout policy and, for ffmpeg itself, the progress channel that
 * policy depends on. `progress:false` is for a NON-ffmpeg producer (qt-faststart
 * takes no such flag) — it still runs under the inactivity cap, which for a tool
 * that prints nothing degenerates to a plain budget; that is acceptable only
 * because a faststart failure degrades loudly instead of losing the derivative.
 *
 * Every other `runBinary(` in this module is a READ-ONLY probe, and invariant 7
 * of `test/unit/media_writer_discipline_tripwire.test.ts` holds that line.
 */
async function runProducer(
	argv: readonly string[],
	spawnOptions: SpawnOptions,
	progress = true,
): Promise<SpawnResult> {
	// THE PERMIT IS TAKEN HERE, at the spawn, not at the caller (audit MEDIA-01,
	// the ffmpeg half). This door used to be exempt because "the AV producer runs
	// in a media/jobs.ts lane" — false for `create_posterframe`, which is awaited
	// INLINE in an API handler and belongs to no lane, and for every other inline
	// caller written after that reason was written. A permit at the door bounds
	// all of them; a job takes its lane AND this permit, which is correct.
	return withAvSlot('ffmpeg', () =>
		runBinary(progress ? withProgress(argv) : argv, producerSpawnOptions(spawnOptions)),
	);
}

/**
 * A producer's OUTPUT post-condition: the tool exited 0, so it claims success —
 * prove it wrote something. An exit code is not evidence of a file (the same law
 * `runMagickTo` enforces for ImageMagick); without this an empty temp is renamed
 * over a good derivative and indexed `file_exist:true`, which is the timeout
 * corruption again, one exit code away.
 */
function assertProducedFile(path: string, what: string): void {
	if (!existsSync(path)) {
		throw new Error(`${what} reported success but produced no output file (${path})`);
	}
	if (statSync(path).size === 0) {
		throw new Error(`${what} reported success but produced an empty output file (${path})`);
	}
}

/**
 * The profile's video filter chain as argv: ONE `-vf a,b` (or nothing).
 * Never one `-vf` per filter — ffmpeg keeps only the last `-vf` of an output
 * stream, which is how PHP's recipe silently dropped `yadif` (deinterlace).
 */
export function videoFilterArgv(profile: FfmpegProfile): string[] {
	return profile.videoFilters.length === 0 ? [] : ['-vf', profile.videoFilters.join(',')];
}

/**
 * Two-pass libx264 video encode — PASS 1 argv (PHP :766).
 * `<ffmpeg> -i <src> -an -pass 1 -vcodec .. -vb .. -s .. -g .. -vf yadif,<gamma> -f .. -loglevel error -passlogfile <log> -y /dev/null`
 */
export function buildTranscodePass1Argv(
	profile: FfmpegProfile,
	source: string,
	passLog: string,
): string[] {
	if (profile.videoCodec === null)
		throw new Error(`Profile ${profile.name} is audio-only, no video pass`);
	return [
		ffmpeg(),
		'-i',
		source,
		'-an',
		'-pass',
		'1',
		'-vcodec',
		profile.videoCodec,
		'-vb',
		profile.videoBitrate ?? '',
		'-s',
		profile.scale ?? '',
		'-g',
		String(profile.gop ?? 0),
		...videoFilterArgv(profile),
		'-f',
		profile.force,
		'-loglevel',
		'error',
		'-passlogfile',
		passLog,
		'-y',
		'/dev/null',
	];
}

/**
 * Two-pass libx264 video encode — PASS 2 argv (PHP :773-775): adds the audio
 * track and writes the temp output.
 */
export function buildTranscodePass2Argv(
	profile: FfmpegProfile,
	source: string,
	passLog: string,
	tempTarget: string,
	audioCodec: string,
): string[] {
	if (profile.videoCodec === null)
		throw new Error(`Profile ${profile.name} is audio-only, no video pass`);
	return [
		ffmpeg(),
		'-i',
		source,
		'-pass',
		'2',
		'-vcodec',
		profile.videoCodec,
		'-vb',
		profile.videoBitrate ?? '',
		'-s',
		profile.scale ?? '',
		'-g',
		String(profile.gop ?? 0),
		...videoFilterArgv(profile),
		'-f',
		profile.force,
		'-passlogfile',
		passLog,
		'-acodec',
		audioCodec,
		'-ar',
		String(profile.audioRate ?? 44100),
		'-ab',
		profile.audioBitrate ?? '128k',
		'-ac',
		String(profile.audioChannels ?? 2),
		// Not in PHP's recipe. Logging only — the encoded bytes are identical — but a
		// failing pass 2 then reports its ERROR line instead of a stderr tail of
		// banner, stream dump and per-frame stats (the pass 1 twin above).
		'-loglevel',
		'error',
		'-y',
		tempTarget,
	];
}

/** Audio-only extraction argv (PHP :710): -vn -acodec .. -ar 44100 -ab 128k -ac 2 -loglevel error. */
export function buildAudioArgv(source: string, target: string, audioCodec: string): string[] {
	return [
		ffmpeg(),
		'-i',
		source,
		'-vn',
		'-acodec',
		audioCodec,
		'-ar',
		'44100',
		'-ab',
		'128k',
		'-ac',
		'2',
		// Logging only (bytes unchanged): a failed extraction reports its error line.
		'-loglevel',
		'error',
		target,
	];
}

/**
 * Speech-to-text audio (audio_tr) argv: 16 kHz mono WAV, high-passed and loudness
 * normalised.
 *
 * The rate and channel count are what the recogniser requires. The filter chain is
 * a QUALITY measure, added 2026-07-28: field recordings of interviews carry rumble,
 * handling noise and wildly inconsistent levels, and a recogniser fed quiet or
 * rumbling audio is far likelier to hallucinate repeated words — the failure this
 * whole pass exists to remove.
 *   highpass=f=80  drops rumble and mains hum below the human voice;
 *   loudnorm       brings the speech to a consistent level (EBU R128 target), so a
 *                  softly-spoken informant is not transcribed as silence.
 *
 * Safe to change: audio_tr is a throwaway derivative, rebuilt on demand and deleted
 * after each transcription — no stored data depends on its bytes.
 */
export function buildAudioTrArgv(source: string, target: string): string[] {
	return [
		ffmpeg(),
		'-i',
		source,
		'-vn',
		'-af',
		'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11',
		'-ar',
		'16000',
		'-ac',
		'1',
		target,
	];
}

/** qt-faststart argv (moov-atom relocation): <qt-faststart> <src> <dst>. */
export function buildFaststartArgv(binary: string, source: string, target: string): string[] {
	return [binary, source, target];
}

/**
 * The SECOND moov-relocation route: ffmpeg's own `-movflags +faststart` remux
 * (stream copy, no re-encode — same result as qt-faststart, different tool).
 * `format` is the container (`profile.force`), needed because the scratch file
 * has no meaningful extension for ffmpeg to infer a muxer from.
 */
export function buildMovflagsFaststartArgv(
	source: string,
	target: string,
	format?: string,
): string[] {
	return [
		ffmpeg(),
		'-y',
		'-i',
		source,
		'-c',
		'copy',
		'-movflags',
		'+faststart',
		...(format === undefined ? [] : ['-f', format]),
		'-loglevel',
		'error',
		target,
	];
}

/**
 * Posterframe extraction argv (PHP create_posterframe :1153):
 * `<ffmpeg> -ss <tc> -i <src> -y -vframes 1 -f rawvideo -an -vcodec mjpeg -s WxH <dst>`.
 */
export function buildPosterframeArgv(
	source: string,
	timecode: string,
	target: string,
	size: { width: number; height: number },
): string[] {
	// number_format(x,3) parity: 3 decimal places.
	const tc = Number(timecode);
	const formatted = Number.isFinite(tc) ? tc.toFixed(3) : '0.000';
	return [
		ffmpeg(),
		'-ss',
		formatted,
		'-i',
		source,
		'-y',
		'-vframes',
		'1',
		'-f',
		'rawvideo',
		'-an',
		'-vcodec',
		'mjpeg',
		'-s',
		`${size.width}x${size.height}`,
		target,
	];
}

/** conform_header remux argv (PHP :1374): -c:v copy -c:a copy into a temp. */
export function buildConformHeaderArgv(source: string, tempTarget: string): string[] {
	return [ffmpeg(), '-i', source, '-c:v', 'copy', '-c:a', 'copy', tempTarget];
}

/** build_fragment (no watermark) argv (PHP :1281): -ss in -i src -t dur -vcodec copy -acodec copy -y dst. */
export function buildFragmentArgv(
	source: string,
	target: string,
	startTc: string,
	durationSeconds: number,
): string[] {
	return [
		ffmpeg(),
		'-ss',
		startTc,
		'-i',
		source,
		'-t',
		String(durationSeconds),
		'-vcodec',
		'copy',
		'-acodec',
		'copy',
		'-y',
		target,
	];
}

// -------- probes --------

/** ffprobe -show_format as parsed JSON (PHP get_media_attributes :1585). */
export async function probeFormat(source: string): Promise<unknown> {
	const result = await runBinary(
		[ffprobe(), '-v', 'quiet', '-print_format', 'json', '-show_format', source],
		{ nice: false },
	);
	try {
		return JSON.parse(result.stdout);
	} catch {
		return null;
	}
}

/** ffprobe -show_streams as parsed JSON (PHP get_media_streams :1651). */
export async function probeStreams(source: string): Promise<{ streams: MediaStream[] } | null> {
	const result = await runBinary(
		[ffprobe(), '-v', 'quiet', '-show_streams', '-print_format', 'json', source],
		{ nice: false },
	);
	try {
		return JSON.parse(result.stdout) as { streams: MediaStream[] };
	} catch {
		return null;
	}
}

/** The stream fields the engine reads (a subset of ffprobe's stream object). */
export interface MediaStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	display_aspect_ratio?: string;
	duration?: string;
	channels?: number;
	sample_rate?: string;
}

/** Whether the source has a video stream (PHP posterframe guard :1108-1114). */
export async function hasVideoStream(source: string): Promise<boolean> {
	const probe = await probeStreams(source);
	return probe?.streams?.some((s) => s.codec_type === 'video') ?? false;
}

/**
 * Broadcast standard from source fps (PHP get_media_standard :321): ≥29 → ntsc.
 * Returns 'pal' when the fps is unknown or below the NTSC threshold.
 */
export function standardFromFps(avgFrameRate: string | undefined): 'pal' | 'ntsc' {
	if (!avgFrameRate) return 'pal';
	const parts = avgFrameRate.split('/').map(Number);
	const num = parts[0] ?? 0;
	const den = parts[1] ?? 0;
	const fps = den ? num / den : num;
	return Number.isFinite(fps) && fps >= 29 ? 'ntsc' : 'pal';
}

/**
 * The AAC encoders this engine will use, best first (PHP get_audio_codec :1722).
 * `aac` — FFmpeg's native encoder — closes the list because every build since 3.0
 * carries it, so it is also the answer when the probe cannot run at all.
 */
const AAC_PREFERENCE = ['libfdk_aac', 'libvo_aacenc', 'aac'] as const;

/**
 * Per-BINARY memo of the AAC encoder pick: key = the ffmpeg PATH that was
 * probed, value = the in-flight probe (N concurrent first encodes share ONE
 * spawn). The answer is null when the probe could not run.
 *
 * WHY THE KEY IS THE BINARY. The answer is a fact about ONE executable, and
 * `config.media.binaries.ffmpeg` is the only thing that says which one. A
 * process-wide scalar (the pre-2026-10 `cachedAudioCodec`) answered for whatever
 * binary asked FIRST: a gate pointing config at a fake ffmpeg that claims
 * libfdk-aac primed it, and every later REAL two-pass encode in the same process
 * asked the real ffmpeg for `libfdk_aac` — pass 2 exit 8, "Unknown encoder". The
 * same holds in production for anything that resolves a second ffmpeg in one
 * process. Keyed by path, a different binary is simply probed.
 *
 * ONLY A CONCLUSIVE ANSWER IS KEPT. A failed probe (spawn refused under fd/PID
 * saturation, binary momentarily missing) is a fact about the MOMENT, not the
 * binary: memoized, it would pin the whole server to the fallback encoder for its
 * lifetime. It is answered with the fallback and dropped, so the next encode
 * asks again — the `imagemagick.ts:writableFormatCache` lifecycle.
 *
 * Request-INDEPENDENT by construction: key a binary path, value an encoder name.
 * Allowlisted in module_state_tripwire.
 */
const audioCodecByBinary = new Map<string, Promise<string | null>>();

/**
 * Pick the best available AAC encoder of the CONFIGURED ffmpeg: libfdk_aac >
 * libvo_aacenc > aac. Probed once per binary path (see the cache above).
 */
export async function getAudioCodec(): Promise<string> {
	const binary = ffmpeg();
	let probe = audioCodecByBinary.get(binary);
	if (probe === undefined) {
		const started = probeAudioCodec(binary);
		probe = started;
		audioCodecByBinary.set(binary, started);
		// Never rejects (probeAudioCodec catches), so one arm suffices.
		void started.then((codec) => {
			if (codec === null && audioCodecByBinary.get(binary) === started) {
				audioCodecByBinary.delete(binary);
			}
		});
	}
	return (await probe) ?? 'aac';
}

/**
 * Ask `binary` which AAC encoders it actually HAS, from `ffmpeg -encoders`.
 * Null when the probe could not run or its output is not an encoder list.
 *
 * WHY `-encoders`, NOT PHP's `-buildconf`. `-buildconf` prints the configure
 * FLAGS the binary was built with; `-acodec <name>` resolves against the encoder
 * REGISTRY. The two diverge: `--enable-libfdk-aac --disable-encoder=libfdk_aac`
 * lists the flag and has no encoder, and a regex over the configure line also
 * matches the flag text inside `--extra-cflags`/path arguments. `-encoders`
 * prints that registry itself — the exact table pass 2's `-acodec` is looked up
 * in — one encoder per line as `<6 capability flags> <name> <description>`, a
 * format stable since FFmpeg 1.0, where an audio encoder's first flag is `A`.
 * The six-char legend lines (` A..... = Audio`) carry `=` as their name token and
 * so never match an encoder name.
 */
async function probeAudioCodec(binary: string): Promise<string | null> {
	try {
		const result = await runBinary([binary, '-hide_banner', '-encoders'], { nice: false });
		if (!result.ok) return null;
		const audioEncoders = new Set<string>();
		for (const match of result.stdout.matchAll(/^\s*A[A-Z.]{5}\s+(\S+)/gm)) {
			audioEncoders.add(match[1] as string);
		}
		if (audioEncoders.size === 0) return null; // not an encoder list: inconclusive
		return AAC_PREFERENCE.find((codec) => audioEncoders.has(codec)) ?? 'aac';
	} catch {
		return null;
	}
}

// -------- high-level runners --------

/** Extract a posterframe. Returns false when the source has no video (audio-only). */
export async function createPosterframe(
	source: string,
	timecode: string,
	target: string,
	size: { width: number; height: number },
	spawnOptions: SpawnOptions = {},
): Promise<boolean> {
	// Single probe: video presence + duration (avoids a second hasVideoStream probe).
	const probe = await probeStreams(source);
	const video = probe?.streams?.find((s) => s.codec_type === 'video');
	if (video === undefined) return false; // audio-only source → no posterframe.

	// Clamp the requested seek into the source's valid range. ffmpeg input-seeking
	// (`-ss` before `-i`) PAST the end of a stream yields no frame, so the mjpeg
	// encoder gets no input and errors out — the whole extraction then fails. A
	// too-short or truncated source (or a current_time reported beyond its real
	// duration) would otherwise produce nothing. PHP does not clamp, so this is a
	// strict robustness improvement: for a normal current_time within a real
	// video's duration the timecode is unchanged.
	const effectiveTimecode = clampTimecodeToDuration(timecode, video.duration);
	const result = await runProducer(
		buildPosterframeArgv(source, effectiveTimecode, target, size),
		spawnOptions,
	);
	assertSpawnOk(result, 'ffmpeg posterframe failed');
	assertProducedFile(target, 'ffmpeg posterframe');
	return true;
}

/**
 * Clamp a requested posterframe timecode to `[0, duration)` so a frame is always
 * available. Returns the timecode unchanged when the duration is unknown or the
 * requested time already lies within the stream (the normal case).
 */
function clampTimecodeToDuration(timecode: string, streamDuration: string | undefined): string {
	const requested = Number(timecode);
	const duration = Number(streamDuration);
	if (!Number.isFinite(requested) || !Number.isFinite(duration) || duration <= 0) {
		return timecode;
	}
	if (requested < duration) return timecode;
	// Seek just inside the last available moment (never negative → 0 for tiny clips).
	return String(Math.max(0, duration - 0.1));
}

/** What `applyFaststart` did — see its doc for why every field matters. */
export interface FaststartOutcome {
	/** True when the moov atom was relocated to the front of the file. */
	applied: boolean;
	/** Which route did it, or null when none could. */
	via: 'qt-faststart' | 'ffmpeg-movflags' | null;
	/** The loud reason nothing could relocate the atom (null when applied). */
	error: string | null;
}

/**
 * MOOV RELOCATION — the step PHP ran unconditionally after every two-pass encode
 * (class.Ffmpeg.php:782) and this rewrite had dropped, so every generated web
 * version kept its moov atom at the END and could not progressively stream
 * (audit 2026-08; engineering/MEDIA_SPEC.md §4.2/§7.C/§9 name it a parity gate).
 *
 * It rewrites `file` IN PLACE through a scratch sibling + rename, so the caller's
 * own atomic rename into the served path stays the only publication step.
 *
 * TWO ROUTES, in PHP's order of preference:
 *  1. `qt-faststart` when the install configures it (PHP's exact tool);
 *  2. ffmpeg `-c copy -movflags +faststart` otherwise — the same relocation by
 *     the binary that just did the encode, so an install without qt-faststart
 *     still gets progressive derivatives instead of a silent skip.
 *
 * When BOTH routes fail the file is left as-is and the reason is returned: a
 * moov-at-end derivative is playable and rebuildable, losing it is neither. The
 * caller MUST surface `error` (loudly) — that is what makes this a degradation
 * and not the silent omission it replaces.
 */
export async function applyFaststart(
	file: string,
	options: { format?: string } & SpawnOptions = {},
): Promise<FaststartOutcome> {
	const { format, ...spawnOptions } = options;
	const reasons: string[] = [];

	const binary = resolveFaststart();
	if (binary === null) {
		reasons.push(
			`qt-faststart is not installed at the configured DEDALO_AV_FASTSTART_PATH ('${config.media.binaries.qtFaststart}')`,
		);
	} else {
		const failure = await relocateThrough(
			file,
			(scratch) => buildFaststartArgv(binary, file, scratch),
			spawnOptions,
			false, // qt-faststart is not ffmpeg: no -progress flag to give it
		);
		if (failure === null) return { applied: true, via: 'qt-faststart', error: null };
		reasons.push(`qt-faststart ${failure}`);
	}

	const failure = await relocateThrough(
		file,
		(scratch) => buildMovflagsFaststartArgv(file, scratch, format),
		spawnOptions,
	);
	if (failure === null) return { applied: true, via: 'ffmpeg-movflags', error: null };
	reasons.push(`ffmpeg -movflags +faststart ${failure}`);
	return {
		applied: false,
		via: null,
		error: `faststart could not relocate the moov atom of ${file}: ${reasons.join('; ')}`,
	};
}

/**
 * Run ONE moov-relocation route: `file` → a scratch sibling → back over `file`.
 * Returns null on success, else the reason it did not happen.
 *
 * The scratch is `atomic.ts`'s (`writeAtomically`), never a name invented here:
 * it keeps the target's extension — the movflags route is ffmpeg, which picks its
 * muxer from the output filename whenever no `-f` is given (conformHeader has no
 * profile to take one from) — it carries a uuid, so two relocations of one file
 * cannot share it, and its `finally` is what removes the scratch on every route
 * that fails. A failed route MUST leave `file` exactly as it found it: the caller
 * decides whether a moov-at-end derivative is degradation (an encode) or a hard
 * failure (conform_headers).
 */
async function relocateThrough(
	file: string,
	argvFor: (scratch: string) => string[],
	spawnOptions: SpawnOptions,
	progress = true,
): Promise<string | null> {
	try {
		await writeAtomically(file, async (scratch) => {
			const run = await runProducer(argvFor(scratch), spawnOptions, progress);
			if (!run.ok) throw new Error(describeSpawnFailure(run));
			assertProducedFile(scratch, 'faststart');
		});
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * Conform an AV container's headers (PHP Ffmpeg::conform_header :1346 /
 * component_av::conform_headers :1610). Remuxes the stream (no re-encode:
 * `-c:v copy -c:a copy`) into a temp file, relocates its moov atom, preserves
 * the pre-conform file as `<stem>_untouched.<ext>` and moves the conformed temp
 * onto the source path. Throws on any step failure.
 *
 * ORDER MATTERS: everything that can fail happens BEFORE the source is renamed
 * away. PHP (and this port until 2026-08) moved the source to `_untouched`
 * first, so a failing faststart left NOTHING at the source path — the file the
 * whole install links to, gone, for an operation that only ever meant to move
 * four bytes to the front.
 *
 * A faststart that cannot run at all is a HARD failure here (unlike a derivative
 * encode, where it degrades): relocating the atom is the entire point of the
 * operator's request, and nothing has been touched yet.
 */
export async function conformHeader(
	source: string,
	spawnOptions: SpawnOptions = {},
): Promise<void> {
	const ext = extname(source); // includes the leading dot, or ''
	const untouched = `${dirname(source)}/${basename(source, ext)}_untouched${ext}`;

	// The scratch is atomic.ts's — unique per call and extension-preserving — and
	// its `finally` removes it whatever happens, so no failure path has to
	// remember to. Everything that can fail happens inside it.
	await withTempSibling(source, '', async (temp) => {
		// 1. Remux (stream copy) source → temp.
		const remux = await runProducer(buildConformHeaderArgv(source, temp), spawnOptions);
		assertSpawnOk(remux, 'ffmpeg conform remux failed');
		assertProducedFile(temp, 'ffmpeg conform remux');
		// 2. Relocate the moov atom INSIDE the temp — still nothing published.
		const fast = await applyFaststart(temp, spawnOptions);
		if (!fast.applied) {
			throw new Error(`conform_header: ${fast.error ?? 'faststart failed'}`);
		}
		// 3. Only now: preserve the pre-conform file (PHP mv source → *_untouched)
		//    and publish. Both renames are same-directory metadata operations, so
		//    the window in which `source` does not exist is a single syscall. A job
		//    or claim that LOST its component publishes nothing (job_scope.ts; a
		//    no-op outside one) — asked here, after the remux, right before acting.
		assertJobHold();
		renameSync(source, untouched);
		renameSync(temp, source);
	});
}

/**
 * Extract the audio (or audio_tr) quality — ATOMICALLY. The extraction writes a
 * scratch sibling and only a PROVEN file is renamed onto `target`.
 *
 * That is not decoration: `tools/transcription.ts` hands this the SERVED path and
 * early-returns on `existsSync` for the next call, so a killed extraction writing
 * in place left a truncated WAV that was then cached permanently and fed to the
 * recogniser as if it were the whole interview. A producer owns the atomicity of
 * its own output; a caller cannot be asked to remember it.
 */
export async function extractAudio(
	source: string,
	target: string,
	kind: 'audio' | 'audio_tr',
	spawnOptions: SpawnOptions = {},
): Promise<void> {
	const audioCodec = kind === 'audio_tr' ? null : await getAudioCodec();
	await writeAtomically(target, async (temp) => {
		const argv =
			audioCodec === null
				? buildAudioTrArgv(source, temp)
				: buildAudioArgv(source, temp, audioCodec);
		const result = await runProducer(argv, spawnOptions);
		assertSpawnOk(result, `ffmpeg ${kind} extraction failed`);
		assertProducedFile(temp, `ffmpeg ${kind} extraction`);
	});
}

/**
 * Run the two-pass video transcode for a profile into `tempTarget`. The caller
 * runs `applyFaststart` on it and renames it into place (through
 * `writeAtomically` — this never touches a served path).
 *
 * THROWS on any pass that did not exit 0 — a killed or timed-out pass leaves a
 * truncated, moov-less file, and the whole point of the temp is that such a file
 * never reaches the served path (audit 2026-08 B2). Both passes run under the
 * PRODUCER policy: an inactivity cap, never a wall-clock budget, because an
 * hour-long interview's encode legitimately outruns any constant.
 *
 * THE PASSLOG IS OURS, not the caller's. ffmpeg's `-passlogfile` is a PREFIX it
 * appends `-0.log`/`-0.log.mbtree` to; pass 2 reads what pass 1 wrote, so the two
 * passes must agree on it and nothing else may. Deriving it from `tempTarget` —
 * which is a uuid-bearing atomic temp — is what makes two concurrent builds of the
 * same tier (the job manager runs 3 lanes IN ONE PROCESS) unable to read each
 * other's statistics, and the `finally` removes it on every path.
 */
export async function transcodeTwoPass(
	settingName: string,
	source: string,
	tempTarget: string,
	spawnOptions: SpawnOptions = {},
	progress: TranscodeProgress = {},
): Promise<void> {
	const profile = getFfmpegProfile(settingName);
	if (profile === null) throw new Error(`Unknown ffmpeg profile '${settingName}'`);
	const audioCodec = await getAudioCodec();
	const passLog = `${tempTarget}.passlog`;
	// A two-pass encode is TWO full walks of the source, so each pass owns half the
	// bar. Reporting each pass as 0..100 would run the bar to full, snap to zero,
	// and run again — which reads as a failed-and-restarted job.
	const passOptions = (index: 0 | 1): SpawnOptions =>
		withProgressReader(spawnOptions, progress, index * 0.5, 0.5);
	try {
		const pass1 = await runProducer(
			buildTranscodePass1Argv(profile, source, passLog),
			passOptions(0),
		);
		assertSpawnOk(pass1, `ffmpeg pass 1 failed (${settingName})`);
		const pass2 = await runProducer(
			buildTranscodePass2Argv(profile, source, passLog, tempTarget, audioCodec),
			passOptions(1),
		);
		assertSpawnOk(pass2, `ffmpeg pass 2 failed (${settingName})`);
		assertProducedFile(tempTarget, `ffmpeg ${settingName} transcode`);
	} finally {
		removePassLog(passLog);
	}
}

/**
 * How a long encode reports itself. Both fields must be present for a percentage
 * to exist — without the source duration no fraction is computable, and the
 * reader stays silent rather than inventing one (`ffmpeg_progress.ts`).
 */
export interface TranscodeProgress {
	durationSeconds?: number | null;
	/** Receives 0..1 of the WHOLE operation this options bag describes. */
	onFraction?: (fraction: number) => void;
}

/**
 * Attach a `-progress` reader to a spawn, mapping this run's 0..1 into the
 * `[offset, offset+span]` slice of the caller's overall progress.
 */
function withProgressReader(
	spawnOptions: SpawnOptions,
	progress: TranscodeProgress,
	offset: number,
	span: number,
): SpawnOptions {
	const { onFraction, durationSeconds } = progress;
	if (onFraction === undefined) return spawnOptions;
	const reader = createFfmpegProgressReader(durationSeconds ?? null, (fraction) =>
		onFraction(offset + fraction * span),
	);
	return { ...spawnOptions, onStdout: chainStdout(spawnOptions.onStdout, reader) };
}

/** Remove ffmpeg's two-pass statistics scratch (`<passLog>-0.log` + .mbtree). */
function removePassLog(passLog: string): void {
	for (const suffix of ['-0.log', '-0.log.mbtree']) {
		rmSync(`${passLog}${suffix}`, { force: true });
	}
}
